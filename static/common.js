// Twoplay — shared frontend infrastructure used by every game page.
//
// `Twoplay.createNet(gameType, opts)` returns a small networking object that
// owns the WebSocket connection, session persistence (scoped per game), and
// reconnect-on-drop — the generic plumbing each game reuses. Each game wires
// its own `onMessage` handler and game-specific UI on top.
window.Twoplay = window.Twoplay || {};

(function () {
  "use strict";

  // ---- DOM + UI helpers -------------------------------------------------
  Twoplay.$ = (id) => document.getElementById(id);

  Twoplay.banner = function (text, kind) {
    const b = Twoplay.$("banner");
    if (!b) return;
    b.textContent = text;
    b.className = "banner " + (kind || "warn");
  };
  Twoplay.hideBanner = function () {
    const b = Twoplay.$("banner");
    if (b) b.className = "banner hidden";
  };

  // Copy text to the clipboard and flash a confirmation on the button.
  Twoplay.copyText = function (text, btn) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text || "").then(() => {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = old), 1200);
    }, () => {});
  };

  // ---- Networking / session / reconnect ---------------------------------
  Twoplay.createNet = function (gameType, opts) {
    opts = opts || {};
    const SESSION_KEY = "twoplay_" + gameType;

    const net = { gameType, ws: null, session: null };
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let intentionalClose = false;

    function loadSession() {
      try {
        return JSON.parse(localStorage.getItem(SESSION_KEY));
      } catch {
        return null;
      }
    }
    function saveSession(data) {
      net.session = Object.assign({}, net.session, data);
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(net.session));
      } catch {}
    }
    function clearSession() {
      net.session = null;
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {}
    }
    net.session = loadSession();

    function send(message) {
      const ws = net.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      } else if (ws) {
        ws.addEventListener("open", () => ws.send(JSON.stringify(message)), {
          once: true,
        });
      }
    }

    function connect() {
      intentionalClose = false;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      net.ws = ws;
      ws.addEventListener("open", () => {
        reconnectAttempts = 0;
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (opts.onMessage) opts.onMessage(msg);
      });
      ws.addEventListener("close", () => {
        if (net.ws !== ws) return; // already replaced
        if (intentionalClose) return; // user left on purpose
        const sess = loadSession();
        if (sess && (!opts.shouldReconnect || opts.shouldReconnect())) {
          scheduleReconnect();
        } else if (opts.onConnectionLost) {
          opts.onConnectionLost();
        }
      });
      return ws;
    }

    function doReconnect() {
      const sess = loadSession();
      if (!sess) return;
      connect();
      send({
        type: "rejoin",
        game_type: gameType,
        room_code: sess.roomCode,
        role: sess.role,
        token: sess.token,
      });
    }

    function scheduleReconnect() {
      if (reconnectTimer) return;
      if (opts.onReconnecting) opts.onReconnecting();
      const delay = Math.min(800 * Math.pow(1.7, reconnectAttempts), 5000);
      reconnectAttempts++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        doReconnect();
      }, delay);
    }

    function attemptReconnectNow() {
      const sess = loadSession();
      if (!sess) return;
      const ws = net.ws;
      if (
        ws &&
        (ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectAttempts = 0;
      doReconnect();
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") attemptReconnectNow();
    });
    window.addEventListener("online", attemptReconnectNow);
    window.addEventListener("focus", attemptReconnectNow);

    // Close the socket on purpose (used when leaving a game deliberately).
    function leave() {
      intentionalClose = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (net.ws) {
        try {
          net.ws.close();
        } catch {}
      }
      net.ws = null;
    }

    Object.assign(net, {
      connect,
      send,
      doReconnect,
      leave,
      loadSession,
      saveSession,
      clearSession,
    });
    return net;
  };
})();
