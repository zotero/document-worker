// Minimal worker-like environment for JavaScriptCore.
(function () {
  if (typeof globalThis === "undefined") {
    this.globalThis = this;
  }
  var g = globalThis;

  g.console = g.console || {
    log: function () { __nativeLog(Array.prototype.slice.call(arguments)); },
    warn: function () { __nativeLog(Array.prototype.slice.call(arguments)); },
    error: function () { __nativeLog(Array.prototype.slice.call(arguments)); }
  };

  g.navigator = g.navigator || { userAgent: "Zotero-iOS-JSC" };

  if (typeof g.window === "undefined") {
    g.window = g;
  }

  if (typeof g.document === "undefined") {
    g.document = {
      body: { append: function () {}, appendChild: function () {} },
      currentScript: null,
      baseURI: "file://",
      location: { href: "file://", origin: "null" },
      createElement: function () {
        return {
          style: {},
          setAttribute: function () {},
          append: function () {},
          appendChild: function () {},
          addEventListener: function () {},
          removeEventListener: function () {},
          getContext: function () { return null; }
        };
      },
      addEventListener: function () {},
      removeEventListener: function () {},
      getSelection: function () { return null; }
    };
  }

  if (typeof g.Node === "undefined") {
    g.Node = function () {};
  }
  if (typeof g.HTMLInputElement === "undefined") {
    g.HTMLInputElement = function () {};
  }
  if (typeof g.HTMLButtonElement === "undefined") {
    g.HTMLButtonElement = function () {};
  }

  if (typeof g.DOMException === "undefined") {
    g.DOMException = function (message, name) {
      this.message = String(message || "");
      this.name = String(name || "Error");
      if (g.Error && g.Error.captureStackTrace) {
        g.Error.captureStackTrace(this, g.DOMException);
      }
    };
    g.DOMException.prototype = Object.create(g.Error ? g.Error.prototype : Object.prototype);
    g.DOMException.prototype.constructor = g.DOMException;
  }

  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = function (init) {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      this.is2D = true; this.isIdentity = true;
    };
  }

  // --- AbortController / AbortSignal (minimal) ---
  if (typeof g.AbortSignal === "undefined") {
    g.AbortSignal = function AbortSignal() {
      this.aborted = false;
      this.reason = undefined;
      this.onabort = null;
      this._listeners = [];
    };
    g.AbortSignal.prototype.addEventListener = function (type, cb) {
      if (type !== "abort" || typeof cb !== "function") return;
      this._listeners.push(cb);
    };
    g.AbortSignal.prototype.removeEventListener = function (type, cb) {
      if (type !== "abort") return;
      this._listeners = this._listeners.filter(function (x) { return x !== cb; });
    };
    g.AbortSignal.prototype._dispatchAbort = function () {
      if (typeof this.onabort === "function") {
        try { this.onabort({ type: "abort" }); } catch (e) {}
      }
      for (var i = 0; i < this._listeners.length; i++) {
        try { this._listeners[i]({ type: "abort" }); } catch (e) {}
      }
    };
  }

  if (typeof g.AbortController === "undefined") {
    g.AbortController = function AbortController() {
      this.signal = new g.AbortSignal();
    };
    g.AbortController.prototype.abort = function (reason) {
      var s = this.signal;
      if (s.aborted) return;
      s.aborted = true;
      s.reason = reason;
      if (s._dispatchAbort) s._dispatchAbort();
    };
  }

  g.crypto = g.crypto || {};
  if (!g.crypto.getRandomValues) {
    g.crypto.getRandomValues = function (u8) { return __nativeRandom(u8); };
  }
  if (!g.crypto.randomUUID) {
    g.crypto.randomUUID = function () { return __nativeUUID(); };
  }

  g.atob = g.atob || function (str) { return __nativeAtob(str); };
  g.btoa = g.btoa || function (str) { return __nativeBtoa(str); };

  if (typeof g.TextDecoder === "undefined") {
    g.TextDecoder = function (encoding) {
      this.decode = function (u8) {
        if (u8 == null) return "";
        return __nativeTextDecode(u8, (encoding || "utf-8"));
      };
    };
  }

  // --- Blob (minimal, stores raw parts) ---
  if (typeof g.Blob === "undefined") {
    g.Blob = function Blob(parts, options) {
      this._parts = parts || [];
      this.type = (options && options.type) || "";
    };
  }

  // --- URL with blob store ---
  var _blobStore = {};
  var _blobId = 0;

  if (typeof g.URL === "undefined") {
    g.URL = function (url, base) {
      this.href = base ? String(base) + String(url) : String(url);
      this.origin = "null";
    };
  }
  g.URL.createObjectURL = function (blob) {
    var id = "blob:jsctx/" + (++_blobId);
    _blobStore[id] = blob;
    return id;
  };
  g.URL.revokeObjectURL = function (url) {
    delete _blobStore[url];
  };

  // --- fetch (handles blob: URLs only) ---
  if (typeof g.fetch === "undefined") {
    g.fetch = function (url) {
      var blobUrl = typeof url === "string" ? url : (url && url.href) || "";
      var blob = _blobStore[blobUrl];
      if (!blob) {
        return Promise.reject(new Error("fetch: unsupported URL: " + blobUrl));
      }
      var parts = blob._parts || [];
      var totalLen = 0;
      var arrays = [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p instanceof ArrayBuffer) { arrays.push(new Uint8Array(p)); }
        else if (p instanceof Uint8Array) { arrays.push(p); }
        else if (p && p.buffer) { arrays.push(new Uint8Array(p.buffer, p.byteOffset, p.byteLength)); }
      }
      for (var j = 0; j < arrays.length; j++) { totalLen += arrays[j].length; }
      var merged = new Uint8Array(totalLen);
      var off = 0;
      for (var k = 0; k < arrays.length; k++) {
        merged.set(arrays[k], off);
        off += arrays[k].length;
      }
      var buf = merged.buffer;
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: function () { return Promise.resolve(buf); }
      });
    };
  }
  if (typeof g.URLSearchParams === "undefined") {
    g.URLSearchParams = function () {
      this.get = function () { return null; };
      this.set = function () {};
      this.delete = function () {};
      this.has = function () { return false; };
      this.toString = function () { return ""; };
    };
  }

  if (typeof g.performance === "undefined") {
    g.performance = { now: function () { return Date.now(); } };
  }

  if (typeof g.setTimeout === "undefined") {
    g.setTimeout = function (fn, ms) { return __nativeSetTimeout(fn, ms || 0); };
  }
  if (typeof g.clearTimeout === "undefined") {
    g.clearTimeout = function (id) { __nativeClearTimeout(id); };
  }
  if (typeof g.setInterval === "undefined") {
    g.setInterval = function (fn, ms) { return __nativeSetInterval(fn, ms || 0); };
  }
  if (typeof g.clearInterval === "undefined") {
    g.clearInterval = function (id) { __nativeClearInterval(id); };
  }

  if (typeof g.MessageChannel === "undefined") {
    g.MessageChannel = function () {
      var port1 = {
        onmessage: null,
        postMessage: function (msg) {
          if (port2.onmessage) {
            port2.onmessage({ data: msg });
          }
        }
      };
      var port2 = {
        onmessage: null,
        postMessage: function (msg) {
          if (port1.onmessage) {
            port1.onmessage({ data: msg });
          }
        }
      };
      this.port1 = port1;
      this.port2 = port2;
    };
  }

  g.self = g;
  g.onmessage = null;
  g.postMessage = function (msg, transfer) {
    __nativePostMessage(msg, transfer || []);
  };
})();
