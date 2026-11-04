<?php
/**
 * Runs the WordPress plugin outside WordPress with tiny stand-ins for the
 * WordPress/WooCommerce functions it calls, then prints the request it would
 * send (JSON). tests/unit/plugin.test.js feeds that request to the real server
 * to prove both sides agree on the payload and the signature.
 *
 *   php tests/php/plugin-harness.php <webhook-url> <secret> <site-url>
 */
define('ABSPATH', __DIR__);
$GLOBALS['actions'] = [];
$GLOBALS['options'] = ['anbar_connector_url' => $argv[1], 'anbar_connector_secret' => $argv[2]];
$GLOBALS['site'] = $argv[3];
$GLOBALS['sent'] = [];

function add_action($hook, $cb, $prio = 10, $args = 1) { $GLOBALS['actions'][$hook][] = $cb; }
function add_filter($hook, $cb) {}
function do_action($hook, ...$args) { foreach ($GLOBALS['actions'][$hook] ?? [] as $cb) { $cb(...$args); } }
function plugin_basename($f) { return 'anbar-connector/anbar-connector.php'; }
function get_option($k, $d = false) { return $GLOBALS['options'][$k] ?? $d; }
function update_option($k, $v, $a = null) { $GLOBALS['options'][$k] = $v; return true; }
function wp_json_encode($v, $flags = 0) { return json_encode($v, $flags); }
function home_url() { return $GLOBALS['site']; }
function is_wp_error($x) { return false; }
function wp_remote_retrieve_response_code($r) { return 200; }
function wp_remote_post($url, $args) { $GLOBALS['sent'][] = ['url' => $url, 'headers' => $args['headers'], 'body' => $args['body']]; return ['response' => ['code' => 200]]; }
function get_post_type($id) { return isset($GLOBALS['products'][$id]) ? ($GLOBALS['products'][$id]->type === 'variation' ? 'product_variation' : 'product') : 'post'; }
function taxonomy_exists($t) { return $t === 'pa_pack'; }
function wc_attribute_label($t) { return $t === 'pa_pack' ? 'تعداد در بسته' : $t; }
function get_term_by($field, $value, $tax) { return (object) ['name' => str_replace('-', ' ', $value)]; }
function wc_get_product($id) { return $GLOBALS['products'][(int) $id] ?? false; }

class Fake_Date { private $t; function __construct($t) { $this->t = $t; } function getTimestamp() { return $this->t; } }
class Fake_Product
{
    public $type; private $d;
    function __construct($d) { $this->d = $d; $this->type = $d['type']; }
    function get_id() { return $this->d['id']; }
    function get_name() { return $this->d['name']; }
    function get_slug() { return $this->d['slug'] ?? ''; }
    function get_type() { return $this->d['type']; }
    function get_status() { return 'publish'; }
    function get_permalink() { return $GLOBALS['site'] . '/product/' . ($this->d['slug'] ?? 'x') . '/' . ($this->type === 'variation' ? '?attribute_pa_pack=' . $this->d['pack'] : ''); }
    function get_sku($c = 'view') { return 'SKU' . $this->d['id']; }
    function get_regular_price($c = 'view') { return $this->d['regular'] ?? ''; }
    function get_sale_price($c = 'view') { return ''; }
    function get_price($c = 'view') { return $this->d['regular'] ?? ''; }
    function get_stock_status($c = 'view') { return 'instock'; }
    function get_stock_quantity($c = 'view') { return $this->d['qty'] ?? null; }
    function get_manage_stock() { return $this->type === 'variation' ? 'parent' : true; }
    function get_date_modified($c = 'view') { return new Fake_Date(time() - 5); }
    function is_type($t) { return $this->type === $t; }
    function get_children() { return $this->d['children'] ?? []; }
    function get_parent_id() { return $this->d['parent'] ?? 0; }
    function get_attributes() { return $this->type === 'variation' ? ['pa_pack' => $this->d['pack'] . '-عددی'] : []; }
}

$GLOBALS['products'] = [
    10 => new Fake_Product(['id' => 10, 'type' => 'variable', 'name' => 'لیوان کاغذی &amp; درب', 'slug' => 'cup', 'children' => [11, 12], 'qty' => 70]),
    11 => new Fake_Product(['id' => 11, 'type' => 'variation', 'name' => 'لیوان کاغذی &amp; درب', 'parent' => 10, 'pack' => 25, 'regular' => '125000']),
    12 => new Fake_Product(['id' => 12, 'type' => 'variation', 'name' => 'لیوان کاغذی &amp; درب', 'parent' => 10, 'pack' => 100, 'regular' => '460000']),
    20 => new Fake_Product(['id' => 20, 'type' => 'simple', 'name' => 'قاشق چوبی', 'slug' => 'spoon', 'regular' => '99000', 'qty' => 12]),
];

require __DIR__ . '/../../wordpress-plugin/anbar-connector/anbar-connector.php';

// An admin saves the variable product (all its variations go), an order changes a stock, a product is trashed
do_action('woocommerce_update_product', 10);
do_action('woocommerce_product_set_stock', $GLOBALS['products'][20]);
do_action('woocommerce_variation_set_stock', $GLOBALS['products'][12]);
$GLOBALS['products'][30] = new Fake_Product(['id' => 30, 'type' => 'simple', 'name' => 'حذفی', 'regular' => '1']);
do_action('wp_trash_post', 30);
do_action('shutdown');

echo json_encode($GLOBALS['sent'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
