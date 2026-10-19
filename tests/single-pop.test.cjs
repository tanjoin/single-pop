const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const hub = 'https://hub.example/index.html';

function requestUrl(target, nonce = '1') {
    return hub + '#' + new URLSearchParams({ target, request: 'bookmarklet', nonce });
}

function setup({ href = hub, navigationType = 'navigate', blocked = false, lock, stored = '' } = {}) {
    const elements = Object.fromEntries(['url', 'bm', 'focus-btn', 'status'].map(id => [id, {
        value: '',
        attributes: {},
        listeners: {},
        setAttribute(key, value) { this.attributes[key] = value; },
        addEventListener(type, listener) { this.listeners[type] = listener; }
    }]));
    const listeners = {};
    const calls = [];
    const messages = [];
    const pendingLocks = [];
    const storage = new Map([['single-pop-target', stored]]);
    const popup = {
        closed: false,
        focusCount: 0,
        focus() { this.focusCount++; },
        location: {
            get href() { throw new Error('Cross-origin read'); },
            set href(value) { calls.push(['navigate', value]); }
        }
    };
    const context = {
        URL, URLSearchParams,
        performance: { getEntriesByType: () => [{ type: navigationType }] },
        document: { getElementById: id => elements[id] },
        navigator: {},
        localStorage: {
            getItem: key => storage.get(key),
            setItem: (key, value) => storage.set(key, value)
        },
        sessionStorage: {
            getItem: key => storage.get('session:' + key),
            setItem: (key, value) => storage.set('session:' + key, value)
        }
    };
    context.window = {
        location: new URL(href),
        screen: { availWidth: 1440, availHeight: 900 },
        history: { replaceState(state, title, url) { context.window.location = new URL(url); } },
        open(...args) { calls.push(['open', ...args]); return blocked ? null : popup; },
        focus() {},
        addEventListener(type, listener) { listeners[type] = listener; }
    };
    if (lock !== undefined) {
        context.BroadcastChannel = context.window.BroadcastChannel = class {
            constructor() { context.channel = this; }
            postMessage(message) { messages.push(message); }
        };
        context.navigator.locks = {
            request(name, options, callback) {
                if (typeof options === 'function') {
                    pendingLocks.push(options);
                    return new Promise(() => {});
                }
                return Promise.resolve(callback(lock ? {} : null));
            }
        };
    }
    vm.runInNewContext(source, context);
    function input(value) {
        elements.url.value = value;
        elements.url.listeners.input();
    }
    function request(target, nonce = '2') {
        context.window.location = new URL(requestUrl(target, nonce));
        listeners.hashchange({ type: 'hashchange' });
    }
    return { elements, calls, popup, context, messages, pendingLocks, input, request,
        click: () => elements['focus-btn'].listeners.click() };
}

test('normal load restores the target without opening it', () => {
    const app = setup({ stored: 'https://target.example/' });
    assert.equal(app.elements.url.value, 'https://target.example/');
    assert.equal(app.calls.length, 0);
    assert.ok(app.elements.bm.attributes.href.startsWith('javascript:'));
});

test('repeated clicks focus the cross-origin popup without reading its URL', () => {
    const app = setup();
    app.input('https://target.example/');
    app.click();
    app.click();
    assert.equal(app.calls.length, 1);
    assert.equal(app.popup.focusCount, 2);
    app.input('https://other.example/');
    app.click();
    assert.deepEqual(app.calls.at(-1), ['navigate', 'https://other.example/']);
});

test('a closed popup can be opened again', () => {
    const app = setup();
    app.input('https://target.example/');
    app.click();
    app.popup.closed = true;
    app.click();
    assert.equal(app.calls.length, 2);
    assert.equal(app.calls[0][2], app.calls[1][2]);
});

test('a launch request is consumed without double-decoding the URL', () => {
    const target = 'https://target.example/?value=%25&other=a%20b#part';
    const app = setup({ href: requestUrl(target) });
    assert.equal(app.calls[0][1], target);
    assert.equal(app.context.window.location.href, hub);
    app.request(target, '1');
    assert.equal(app.calls.length, 1);
});

for (const navigationType of ['reload', 'back_forward']) {
    test(navigationType + ' does not launch, but a subsequent bookmarklet does', () => {
        const target = 'https://target.example/';
        const app = setup({ href: requestUrl(target), navigationType });
        assert.equal(app.calls.length, 0);
        app.request(target);
        assert.equal(app.calls.length, 1);
    });
}

test('legacy query requests are decoded once', () => {
    const target = 'https://target.example/?value=%25';
    const app = setup({ href: hub + '?target=' + encodeURIComponent(target) });
    assert.equal(app.calls[0][1], target);
});

test('unsafe and malformed targets cannot open windows', () => {
    for (const target of ['javascript:alert(1)', 'data:text/html,hello', 'not a URL']) {
        const app = setup({ href: requestUrl(target) });
        assert.equal(app.calls.length, 0);
        app.input(target);
        assert.equal(app.elements.bm.attributes.href, '#');
        assert.equal(app.elements['focus-btn'].disabled, true);
        app.click();
        assert.equal(app.calls.length, 0);
    }
});

test('popup blocking shows a manual retry state', () => {
    const app = setup({ href: requestUrl('https://target.example/'), blocked: true });
    assert.match(app.elements.status.textContent, /ブロック/);
    assert.equal(app.elements['focus-btn'].disabled, false);
    app.click();
    assert.equal(app.calls.length, 2);
});

test('bookmarklet opens the named relay synchronously with safely encoded URLs', () => {
    const app = setup();
    app.input("https://target.example/?quote='hello'&value=%25");
    const target = new URL(app.elements.url.value).href;
    const code = decodeURIComponent(app.elements.bm.attributes.href.slice(11));
    vm.runInNewContext(code, { window: app.context.window });
    assert.equal(app.calls.length, 1);
    const destination = new URL(app.calls[0][1]);
    assert.equal(app.calls[0][2], 'single_pop_hub');
    assert.equal(new URLSearchParams(destination.hash.slice(1)).get('target'), target);
});

test('only the lock owner opens forwarded requests', () => {
    const owner = setup({ lock: true });
    const follower = setup({ lock: false, href: requestUrl('https://target.example/') });
    assert.equal(follower.calls.length, 0);
    assert.equal(follower.messages.length, 1);
    owner.context.channel.onmessage({ data: follower.messages[0] });
    assert.equal(owner.calls.length, 1);
    owner.context.channel.onmessage({ data: { type: 'OPEN', target: 'javascript:alert(1)' } });
    assert.equal(owner.calls.length, 1);
});

test('a waiting relay takes ownership without opening on takeover', () => {
    const app = setup({ lock: false, stored: 'https://target.example/' });
    assert.equal(app.pendingLocks.length, 1);
    app.pendingLocks[0]({});
    assert.equal(app.calls.length, 0);
    app.click();
    assert.equal(app.calls.length, 1);
});