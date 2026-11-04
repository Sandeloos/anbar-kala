<?php
/**
 * Plugin Name:       اتصال انبار (Anbar Connector)
 * Description:       هر تغییر قیمت، موجودی، نام یا وضعیت کالاها را همان لحظه به نرم‌افزار «انبار» خبر می‌دهد. فقط می‌فرستد؛ چیزی در سایت تغییر نمی‌دهد.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * WC requires at least: 5.0
 * Text Domain:       anbar-connector
 *
 * How it works: WooCommerce hooks collect the ids of products/variations that
 * changed during a request; at shutdown one signed POST carries their current
 * data (shaped like the WooCommerce REST API) to the Anbar server:
 *   X-Anbar-Timestamp: <unix seconds>
 *   X-Anbar-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the shared secret>
 * Missed pushes are harmless: Anbar also reads the site on a schedule.
 */

if (!defined('ABSPATH')) {
    exit;
}

final class Anbar_Connector
{
    const OPT_URL = 'anbar_connector_url';
    const OPT_SECRET = 'anbar_connector_secret';
    const OPT_STATUS = 'anbar_connector_status';
    const VERSION = '1.0.0';

    /** @var array<int,bool> */
    private static $queue = [];
    /** @var int[] */
    private static $deleted = [];

    public static function init()
    {
        $q = [__CLASS__, 'queue_product'];
        add_action('woocommerce_new_product', $q, 20, 1);
        add_action('woocommerce_update_product', $q, 20, 1);
        add_action('woocommerce_new_product_variation', $q, 20, 1);
        add_action('woocommerce_update_product_variation', $q, 20, 1);
        // Stock changed by orders is written straight to the database: these are the only signals
        add_action('woocommerce_product_set_stock', [__CLASS__, 'queue_object'], 20, 1);
        add_action('woocommerce_variation_set_stock', [__CLASS__, 'queue_object'], 20, 1);
        add_action('woocommerce_product_set_stock_status', $q, 20, 1);
        add_action('woocommerce_variation_set_stock_status', $q, 20, 1);
        add_action('wp_trash_post', [__CLASS__, 'queue_deleted'], 10, 1);
        add_action('before_delete_post', [__CLASS__, 'queue_deleted'], 10, 1);
        add_action('untrash_post', $q, 20, 1);
        add_action('shutdown', [__CLASS__, 'flush'], 20);

        add_action('admin_menu', [__CLASS__, 'menu']);
        add_action('admin_post_anbar_connector_save', [__CLASS__, 'save']);
        add_filter('plugin_action_links_' . plugin_basename(__FILE__), [__CLASS__, 'links']);
        add_action('before_woocommerce_init', function () {
            if (class_exists('\Automattic\WooCommerce\Utilities\FeaturesUtil')) {
                \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
            }
        });
    }

    /* ------------------------------------------------------------ collecting */

    public static function queue_product($id)
    {
        $id = is_object($id) && method_exists($id, 'get_id') ? $id->get_id() : (int) $id;
        if ($id > 0) {
            self::$queue[$id] = true;
        }
    }

    public static function queue_object($product)
    {
        if (is_object($product) && method_exists($product, 'get_id')) {
            self::$queue[(int) $product->get_id()] = true;
        }
    }

    public static function queue_deleted($post_id)
    {
        $type = get_post_type($post_id);
        if ($type === 'product' || $type === 'product_variation') {
            self::$deleted[] = (int) $post_id;
            unset(self::$queue[(int) $post_id]);
            // A deleted variable product takes its variations with it
            if ($type === 'product') {
                $product = wc_get_product($post_id);
                if ($product && $product->is_type('variable')) {
                    foreach ($product->get_children() as $child) {
                        self::$deleted[] = (int) $child;
                    }
                }
            }
        }
    }

    /* ------------------------------------------------------------ the payload */

    private static function gmt($date)
    {
        return $date ? gmdate('Y-m-d\TH:i:s', $date->getTimestamp()) : null;
    }

    private static function attribute_label($taxonomy)
    {
        return taxonomy_exists($taxonomy) ? wc_attribute_label($taxonomy) : wc_attribute_label(str_replace('attribute_', '', $taxonomy));
    }

    /** The same fields (and names) the WooCommerce REST API returns. */
    public static function item($p)
    {
        $item = [
            'id' => $p->get_id(),
            'name' => $p->get_name(),
            'slug' => $p->get_slug(),
            'type' => $p->get_type(),
            'status' => $p->get_status(),
            'permalink' => $p->get_permalink(),
            'sku' => $p->get_sku('edit'),
            'regular_price' => (string) $p->get_regular_price('edit'),
            'sale_price' => (string) $p->get_sale_price('edit'),
            'price' => (string) $p->get_price('edit'),
            'stock_status' => $p->get_stock_status('edit'),
            'stock_quantity' => $p->get_stock_quantity('edit'),
            'manage_stock' => $p->get_manage_stock(),
            'date_modified_gmt' => self::gmt($p->get_date_modified('edit')),
            'attributes' => [],
        ];
        if ($p->is_type('variation')) {
            foreach ($p->get_attributes() as $taxonomy => $value) {
                $option = $value;
                if (taxonomy_exists($taxonomy)) {
                    $term = get_term_by('slug', $value, $taxonomy);
                    if ($term && !is_wp_error($term)) {
                        $option = $term->name;
                    }
                }
                $item['attributes'][] = ['name' => self::attribute_label($taxonomy), 'option' => $option];
            }
            $parent = wc_get_product($p->get_parent_id());
            if ($parent) {
                $item['parent'] = [
                    'id' => $parent->get_id(),
                    'name' => $parent->get_name(),
                    'slug' => $parent->get_slug(),
                    'permalink' => $parent->get_permalink(),
                    'stock_quantity' => $parent->get_stock_quantity('edit'),
                ];
            }
        }
        return $item;
    }

    /** Everything queued during this request → one signed POST. */
    public static function flush()
    {
        if (!self::$queue && !self::$deleted) {
            return;
        }
        $items = [];
        $seen = [];
        foreach (array_keys(self::$queue) as $id) {
            $product = wc_get_product($id);
            if (!$product) {
                continue;
            }
            // A variable product is not sold itself; its variations are
            $list = $product->is_type('variable') ? array_filter(array_map('wc_get_product', $product->get_children())) : [$product];
            foreach ($list as $p) {
                if (isset($seen[$p->get_id()])) {
                    continue;
                }
                $seen[$p->get_id()] = true;
                $items[] = self::item($p);
            }
        }
        $deleted = array_values(array_unique(self::$deleted));
        self::$queue = [];
        self::$deleted = [];
        if (!$items && !$deleted) {
            return;
        }
        if (function_exists('fastcgi_finish_request')) {
            // Shutdown runs after the page is complete: hand it to the browser so nobody waits for us
            fastcgi_finish_request();
        }
        foreach (array_chunk($items, 200) as $i => $chunk) {
            self::send(['items' => $chunk, 'deleted' => $i === 0 ? $deleted : []]);
        }
        if (!$items) {
            self::send(['items' => [], 'deleted' => $deleted]);
        }
    }

    /** Signs and sends a payload; returns [ok, message]. */
    public static function send(array $payload, $timeout = 6)
    {
        $url = trim((string) get_option(self::OPT_URL, ''));
        $secret = (string) get_option(self::OPT_SECRET, '');
        if ($url === '' || $secret === '') {
            return [false, 'آدرس یا رمز اتصال تنظیم نشده است.'];
        }
        $body = wp_json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $ts = (string) time();
        $signature = hash_hmac('sha256', $ts . '.' . $body, $secret);
        $res = wp_remote_post($url, [
            'timeout' => $timeout,
            'redirection' => 0,
            'headers' => [
                'Content-Type' => 'application/json; charset=utf-8',
                'X-Anbar-Timestamp' => $ts,
                'X-Anbar-Signature' => 'sha256=' . $signature,
                'User-Agent' => 'AnbarConnector/' . self::VERSION . '; ' . home_url(),
            ],
            'body' => $body,
            'data_format' => 'body',
        ]);
        if (is_wp_error($res)) {
            $result = [false, 'ارسال نشد: ' . $res->get_error_message()];
        } else {
            $code = (int) wp_remote_retrieve_response_code($res);
            $result = $code === 200 ? [true, 'ارسال شد'] : [false, 'سرور انبار جواب ' . $code . ' داد' . ($code === 401 ? ' (رمز اتصال درست نیست)' : '')];
        }
        update_option(self::OPT_STATUS, ['ok' => $result[0], 'message' => $result[1], 'time' => time()], false);
        return $result;
    }

    /* ------------------------------------------------------------ settings page */

    public static function links($links)
    {
        array_unshift($links, '<a href="' . esc_url(admin_url('options-general.php?page=anbar-connector')) . '">تنظیمات</a>');
        return $links;
    }

    public static function menu()
    {
        add_options_page('اتصال انبار', 'اتصال انبار', 'manage_woocommerce', 'anbar-connector', [__CLASS__, 'page']);
    }

    public static function save()
    {
        if (!current_user_can('manage_woocommerce')) {
            wp_die('دسترسی ندارید.');
        }
        check_admin_referer('anbar_connector_save');
        $url = esc_url_raw(wp_unslash($_POST['anbar_url'] ?? ''));
        $secret = sanitize_text_field(wp_unslash($_POST['anbar_secret'] ?? ''));
        update_option(self::OPT_URL, $url, false);
        if ($secret !== '') {
            update_option(self::OPT_SECRET, $secret, false);
        }
        list($ok, $message) = self::send(['ping' => true], 15);
        $args = ['page' => 'anbar-connector', 'anbar_result' => $ok ? 'ok' : 'error', 'anbar_message' => rawurlencode($message)];
        wp_safe_redirect(add_query_arg($args, admin_url('options-general.php')));
        exit;
    }

    public static function page()
    {
        if (!current_user_can('manage_woocommerce')) {
            return;
        }
        $url = (string) get_option(self::OPT_URL, '');
        $has_secret = get_option(self::OPT_SECRET, '') !== '';
        $status = get_option(self::OPT_STATUS, null);
        echo '<div class="wrap" dir="rtl"><h1>اتصال انبار</h1>';
        echo '<p>این دو مقدار را از صفحه‌ی همین شرکت در نرم‌افزار «انبار» (بخش «افزونه‌ی وردپرس») کپی کنید.</p>';
        if (isset($_GET['anbar_result'])) {
            $ok = $_GET['anbar_result'] === 'ok';
            $msg = sanitize_text_field(rawurldecode(wp_unslash($_GET['anbar_message'] ?? '')));
            echo '<div class="notice notice-' . ($ok ? 'success' : 'error') . '"><p>' . ($ok ? 'اتصال برقرار است. از این به بعد هر تغییر کالا همان لحظه به انبار می‌رسد.' : esc_html($msg)) . '</p></div>';
        }
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        wp_nonce_field('anbar_connector_save');
        echo '<input type="hidden" name="action" value="anbar_connector_save">';
        echo '<table class="form-table" role="presentation"><tr><th scope="row"><label for="anbar_url">آدرس دریافت</label></th>';
        echo '<td><input type="url" class="regular-text code" dir="ltr" id="anbar_url" name="anbar_url" value="' . esc_attr($url) . '" required></td></tr>';
        echo '<tr><th scope="row"><label for="anbar_secret">رمز اتصال</label></th>';
        echo '<td><input type="password" class="regular-text code" dir="ltr" id="anbar_secret" name="anbar_secret" value="" autocomplete="off" placeholder="' . ($has_secret ? 'ذخیره شده؛ برای تغییر، رمز جدید را وارد کنید' : '') . '"' . ($has_secret ? '' : ' required') . '></td></tr></table>';
        submit_button('ذخیره و آزمایش اتصال');
        echo '</form>';
        if (is_array($status)) {
            echo '<p>آخرین ارسال: ' . esc_html(wp_date('Y/m/d H:i', (int) $status['time'])) . ' — ' . esc_html($status['message']) . '</p>';
        }
        echo '</div>';
    }
}

Anbar_Connector::init();
