// Battleship — game controller, built on the shared Twoplay networking layer.
(function () {
  "use strict";

  const $ = Twoplay.$;
  const GAME_TYPE = "battleship";

  const state = {
    roomCode: null,
    role: null,
    token: null,
    gridSize: 10,
    turnRule: "strict",
    fleet: [],          // [{id, name, label, length}]
    // Placement
    placed: {},         // id -> [[r,c], ...]
    currentShipId: null,
    orientation: "H",   // "H" | "V"
    ready: false,
    // Live game
    started: false,
    gameOver: false,
    turn: null,
    myTurn: false,
    shipCells: new Set(),   // my own ship cells, as "r,c"
    myShots: [],            // shots I fired:   {row,col,result,sunk_ship}
    incomingShots: [],      // shots fired at me:{row,col,result,sunk_ship}
  };

  // ---- Shared networking ------------------------------------------------
  const net = Twoplay.createNet(GAME_TYPE, {
    onMessage: handleMessage,
    shouldReconnect: () => !state.gameOver,
    onReconnecting: () => Twoplay.banner("Connection lost — reconnecting…", "warn"),
    onConnectionLost: () => {
      if (!state.gameOver) Twoplay.banner("Connection lost. Refresh to start over.", "error");
    },
  });

  function saveSession() {
    if (state.roomCode && state.role && state.token) {
      net.saveSession({
        roomCode: state.roomCode,
        role: state.role,
        token: state.token,
      });
    }
  }

  // ---- Screens ----------------------------------------------------------
  const screens = {
    home: $("screen-home"),
    lobby: $("screen-lobby"),
    place: $("screen-place"),
    game: $("screen-game"),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.add("hidden"));
    screens[name].classList.remove("hidden");
    $("btn-newgame").classList.toggle("hidden", name === "home");
  }

  // ---- Board building ---------------------------------------------------
  function cellSize(size) {
    return Math.max(16, Math.min(34, Math.floor(340 / size)));
  }

  function buildBoard(container, size, onCellClick) {
    container.innerHTML = "";
    const cs = cellSize(size);
    container.style.setProperty("--cell", cs + "px");
    container.style.gridTemplateColumns = `${cs}px repeat(${size}, ${cs}px)`;

    // Header row: empty corner + column letters.
    const corner = document.createElement("div");
    corner.className = "board-corner";
    container.appendChild(corner);
    for (let c = 0; c < size; c++) {
      const head = document.createElement("div");
      head.className = "board-head";
      head.textContent = String.fromCharCode(65 + c);
      container.appendChild(head);
    }

    const cells = [];
    for (let r = 0; r < size; r++) {
      cells.push([]);
      const num = document.createElement("div");
      num.className = "board-rownum";
      num.textContent = r + 1;
      container.appendChild(num);
      for (let c = 0; c < size; c++) {
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.r = r;
        cell.dataset.c = c;
        if (onCellClick) {
          cell.addEventListener("click", () => onCellClick(r, c));
        }
        cells[r].push(cell);
        container.appendChild(cell);
      }
    }
    container._cells = cells;
    return cells;
  }

  const getCell = (board, r, c) => board._cells && board._cells[r] && board._cells[r][c];

  // ---- Placement --------------------------------------------------------
  function initPlacement() {
    state.placed = {};
    state.ready = false;
    state.orientation = "H";
    state.currentShipId = state.fleet.length ? state.fleet[0].id : null;
    updateRotateLabel();
    $("place-error").classList.add("hidden");
    $("place-status").classList.add("hidden");
    $("btn-ready").disabled = true;
    buildBoard($("place-board"), state.gridSize, onPlaceCell);
    renderFleetList();
    renderPlaceBoard();
    showScreen("place");
  }

  function shipById(id) {
    return state.fleet.find((s) => s.id === id);
  }

  function computeShipCells(ship, r, c) {
    const cells = [];
    for (let i = 0; i < ship.length; i++) {
      cells.push(state.orientation === "H" ? [r, c + i] : [r + i, c]);
    }
    return cells;
  }

  function inBounds(cells) {
    return cells.every(([r, c]) => r >= 0 && r < state.gridSize && c >= 0 && c < state.gridSize);
  }

  function onPlaceCell(r, c) {
    const ship = shipById(state.currentShipId);
    if (!ship) return;
    const cells = computeShipCells(ship, r, c);
    if (!inBounds(cells)) {
      showPlaceError(`${ship.label} won't fit there — try another cell or rotate.`);
      return;
    }
    // Overlap check against every OTHER placed ship.
    const occupied = new Set();
    for (const [id, cs] of Object.entries(state.placed)) {
      if (id === ship.id) continue;
      cs.forEach(([rr, cc]) => occupied.add(rr + "," + cc));
    }
    if (cells.some(([rr, cc]) => occupied.has(rr + "," + cc))) {
      showPlaceError("Ships may not overlap.");
      return;
    }
    state.placed[ship.id] = cells;
    $("place-error").classList.add("hidden");
    // Advance to the next unplaced ship, if any.
    const next = state.fleet.find((s) => !state.placed[s.id]);
    if (next) state.currentShipId = next.id;
    renderFleetList();
    renderPlaceBoard();
    $("btn-ready").disabled = Object.keys(state.placed).length !== state.fleet.length;
  }

  function showPlaceError(msg) {
    const e = $("place-error");
    e.textContent = msg;
    e.classList.remove("hidden");
  }

  function renderFleetList() {
    const list = $("fleet-list");
    list.innerHTML = "";
    state.fleet.forEach((ship) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "fleet-chip";
      if (state.placed[ship.id]) chip.classList.add("placed");
      if (ship.id === state.currentShipId) chip.classList.add("active");
      const name = document.createElement("span");
      name.className = "fleet-name";
      name.textContent = ship.label;
      const cells = document.createElement("span");
      cells.className = "fleet-cells";
      for (let i = 0; i < ship.length; i++) {
        const s = document.createElement("span");
        s.className = "fleet-cell";
        cells.appendChild(s);
      }
      chip.appendChild(name);
      chip.appendChild(cells);
      chip.addEventListener("click", () => {
        state.currentShipId = ship.id;
        renderFleetList();
        renderPlaceBoard();
      });
      list.appendChild(chip);
    });
  }

  function renderPlaceBoard() {
    const board = $("place-board");
    if (!board._cells) return;
    board._cells.flat().forEach((cell) => (cell.className = "cell"));
    for (const [id, cells] of Object.entries(state.placed)) {
      const current = id === state.currentShipId;
      cells.forEach(([r, c]) => {
        const cell = getCell(board, r, c);
        if (cell) {
          cell.classList.add("ship");
          if (current) cell.classList.add("ship-current");
        }
      });
    }
  }

  function rotate() {
    state.orientation = state.orientation === "H" ? "V" : "H";
    updateRotateLabel();
  }
  function updateRotateLabel() {
    $("btn-rotate").textContent =
      "↻ Rotate: " + (state.orientation === "H" ? "Horizontal" : "Vertical");
  }

  function submitPlacement() {
    if (Object.keys(state.placed).length !== state.fleet.length) return;
    const ships = state.fleet.map((s) => ({ id: s.id, cells: state.placed[s.id] }));
    state.shipCells = new Set();
    ships.forEach((s) => s.cells.forEach(([r, c]) => state.shipCells.add(r + "," + c)));
    net.send({ type: "place_ships", ships });
    state.ready = true;
    $("btn-ready").disabled = true;
    $("place-status").classList.remove("hidden");
  }

  // ---- Live game --------------------------------------------------------
  function startGame(firstTurn) {
    state.started = true;
    state.gameOver = false;
    state.myShots = [];
    state.incomingShots = [];
    $("sunk-feed").innerHTML = "";
    $("game-result").classList.add("hidden");
    $("play-again-status").classList.add("hidden");
    buildBoard($("fire-board"), state.gridSize, onFireCell);
    buildBoard($("own-board"), state.gridSize, null);
    renderFireBoard();
    renderOwnBoard();
    setTurn(firstTurn);
    showScreen("game");
  }

  function setTurn(turn) {
    state.turn = turn;
    state.myTurn = turn === state.role;
    const banner = $("turn-banner");
    const fire = $("fire-board");
    if (state.myTurn) {
      banner.textContent = "Your turn — fire a shot!";
      banner.className = "turn-banner my-turn";
      fire.classList.remove("inactive");
    } else {
      banner.textContent = "Opponent's turn — waiting…";
      banner.className = "turn-banner their-turn";
      fire.classList.add("inactive");
    }
  }

  function onFireCell(r, c) {
    if (!state.myTurn || state.gameOver) return;
    if (state.myShots.some((s) => s.row === r && s.col === c)) return;
    net.send({ type: "fire", row: r, col: c });
  }

  function renderFireBoard() {
    const board = $("fire-board");
    if (!board._cells) return;
    board._cells.flat().forEach((cell) => (cell.className = "cell"));
    state.myShots.forEach((s) => {
      const cell = getCell(board, s.row, s.col);
      if (cell) cell.classList.add(s.result === "miss" ? "miss" : "hit", "fired");
      if (cell && s.result === "sunk") cell.classList.add("sunk");
    });
  }

  function renderOwnBoard() {
    const board = $("own-board");
    if (!board._cells) return;
    board._cells.flat().forEach((cell) => (cell.className = "cell"));
    state.shipCells.forEach((key) => {
      const [r, c] = key.split(",").map(Number);
      const cell = getCell(board, r, c);
      if (cell) cell.classList.add("ship");
    });
    state.incomingShots.forEach((s) => {
      const cell = getCell(board, s.row, s.col);
      if (cell) cell.classList.add(s.result === "miss" ? "miss" : "hit");
    });
  }

  function revealOpponentFleet(oppShips) {
    const board = $("fire-board");
    if (!board._cells || !oppShips) return;
    oppShips.forEach((ship) => {
      ship.cells.forEach(([r, c]) => {
        const cell = getCell(board, r, c);
        if (cell && !cell.classList.contains("hit")) cell.classList.add("ship-revealed");
      });
    });
  }

  function announceSunk(shooter, label) {
    if (!label) return;
    const div = document.createElement("div");
    div.className = "sunk-msg";
    if (shooter === state.role) {
      div.classList.add("good");
      div.textContent = `💥 You sank the opponent's ${label}!`;
    } else {
      div.classList.add("bad");
      div.textContent = `🔥 Your ${label} was sunk!`;
    }
    const feed = $("sunk-feed");
    feed.insertBefore(div, feed.firstChild);
    while (feed.children.length > 4) feed.removeChild(feed.lastChild);
  }

  // ---- Message handling -------------------------------------------------
  function handleMessage(msg) {
    switch (msg.type) {
      case "room_created":
        state.roomCode = msg.room_code;
        state.role = msg.player_role || "A";
        state.token = msg.token;
        applyConfig(msg);
        saveSession();
        $("lobby-roomcode").textContent = msg.room_code;
        $("lobby-status").textContent = "Waiting for an opponent to join…";
        showScreen("lobby");
        break;

      case "waiting_for_opponent":
        break;

      case "joined_room":
        state.roomCode = msg.room_code;
        state.role = msg.player_role;
        state.token = msg.token;
        applyConfig(msg);
        saveSession();
        initPlacement();
        break;

      case "opponent_joined":
        // Creator's opponent arrived — both move to fleet placement.
        initPlacement();
        break;

      case "placement_accepted":
        state.ready = true;
        $("place-status").classList.remove("hidden");
        break;

      case "opponent_ready":
        if (!screens.place.classList.contains("hidden")) {
          $("place-hint").textContent = "Opponent is ready and waiting for you.";
        }
        break;

      case "game_start":
        startGame(msg.first_turn);
        break;

      case "fire_result": {
        const shot = {
          row: msg.row,
          col: msg.col,
          result: msg.result,
          sunk_ship: msg.sunk_ship,
        };
        if (msg.shooter === state.role) {
          state.myShots.push(shot);
          renderFireBoard();
        } else {
          state.incomingShots.push(shot);
          renderOwnBoard();
        }
        announceSunk(msg.shooter, msg.sunk_ship);
        if (msg.next_turn) setTurn(msg.next_turn);
        break;
      }

      case "game_over":
        endGame(msg.winner, msg.boards);
        break;

      case "state_sync":
        rebuildFromState(msg);
        break;

      case "rejoin_failed":
        net.clearSession();
        Twoplay.hideBanner();
        Twoplay.banner("Your previous game is no longer available.", "warn");
        showScreen("home");
        break;

      case "opponent_reconnected":
        Twoplay.hideBanner();
        break;

      case "opponent_disconnected":
        Twoplay.banner("Your opponent disconnected — they can rejoin anytime.", "warn");
        break;

      case "room_reset":
        applyConfig(msg);
        // Clear the finished-game flags so reconnect works during replay setup.
        state.gameOver = false;
        state.started = false;
        Twoplay.hideBanner();
        $("game-result").classList.add("hidden");
        $("play-again-status").classList.add("hidden");
        $("btn-play-again").disabled = false;
        $("place-hint").textContent =
          "Select a ship, choose its orientation, then click a cell to place it.";
        initPlacement();
        break;

      case "opponent_left":
        net.clearSession();
        Twoplay.banner("Your opponent left the game.", "warn");
        resetToGameHome();
        break;

      case "error":
        showError(msg.message);
        break;
    }
  }

  function applyConfig(msg) {
    if (msg.grid_size) state.gridSize = msg.grid_size;
    if (msg.turn_rule) state.turnRule = msg.turn_rule;
    if (msg.fleet) state.fleet = msg.fleet;
  }

  function endGame(winner, boards) {
    state.gameOver = true;
    state.turn = null;
    state.myTurn = false;
    const won = winner === state.role;
    const headline = $("over-headline");
    headline.textContent = won ? "🎉 Victory!" : "Defeated";
    headline.className = won ? "win" : "lose";
    $("over-detail").textContent = won
      ? "You sank the opponent's entire fleet — their ships are revealed on the left."
      : "Your fleet was wiped out. The opponent's ships are revealed on the left.";
    if (boards) {
      const oppRole = state.role === "A" ? "B" : "A";
      revealOpponentFleet(boards[oppRole]);
    }
    // Show the result in place so the final, revealed boards stay on screen.
    const banner = $("turn-banner");
    banner.textContent = won ? "🎉 Victory!" : "Defeated";
    banner.className = "turn-banner " + (won ? "my-turn" : "their-turn");
    $("fire-board").classList.add("inactive");
    $("btn-play-again").disabled = false;
    $("play-again-status").classList.add("hidden");
    $("game-result").classList.remove("hidden");
    showScreen("game");
  }

  function rebuildFromState(s) {
    state.roomCode = s.room_code;
    state.role = s.role;
    state.gridSize = s.grid_size;
    state.turnRule = s.turn_rule;
    state.fleet = s.fleet || [];
    state.started = s.started;
    state.gameOver = s.over;
    saveSession();
    Twoplay.hideBanner();

    // Rebuild my own ship cells from the server's record (if I'd placed).
    state.shipCells = new Set();
    (s.your_ships || []).forEach((ship) =>
      ship.cells.forEach(([r, c]) => state.shipCells.add(r + "," + c))
    );
    state.myShots = s.your_shots || [];
    state.incomingShots = s.incoming_shots || [];

    if (!s.started && !s.over && !s.opponent_present) {
      $("lobby-roomcode").textContent = state.roomCode;
      $("lobby-status").textContent = "Waiting for an opponent to join…";
      showScreen("lobby");
      return;
    }

    if (!s.started && !s.over) {
      // Placement phase.
      if (s.you_ready) {
        // Already locked in — show the waiting state with my placed fleet.
        buildBoard($("place-board"), state.gridSize, null);
        renderReadyPlaceBoard();
        $("btn-ready").disabled = true;
        $("place-status").classList.remove("hidden");
        showScreen("place");
      } else {
        initPlacement();
        if (s.opponent_ready) {
          $("place-hint").textContent = "Opponent is ready and waiting for you.";
        }
      }
      return;
    }

    if (s.over) {
      buildBoard($("fire-board"), state.gridSize, onFireCell);
      buildBoard($("own-board"), state.gridSize, null);
      renderFireBoard();
      renderOwnBoard();
      const oppRole = state.role === "A" ? "B" : "A";
      if (s.boards) revealOpponentFleet(s.boards[oppRole]);
      endGame(s.winner, s.boards);
      return;
    }

    // Game in progress.
    buildBoard($("fire-board"), state.gridSize, onFireCell);
    buildBoard($("own-board"), state.gridSize, null);
    renderFireBoard();
    renderOwnBoard();
    setTurn(s.turn);
    showScreen("game");
    if (!s.opponent_connected) {
      Twoplay.banner("Your opponent disconnected — they can rejoin anytime.", "warn");
    }
  }

  // Show my placed fleet on the placement board while waiting (read-only).
  function renderReadyPlaceBoard() {
    const board = $("place-board");
    if (!board._cells) return;
    state.shipCells.forEach((key) => {
      const [r, c] = key.split(",").map(Number);
      const cell = getCell(board, r, c);
      if (cell) cell.classList.add("ship");
    });
  }

  function showError(message) {
    if (!screens.place.classList.contains("hidden")) {
      showPlaceError(message);
    } else {
      Twoplay.banner(message, "error");
    }
  }

  // ---- Leaving ----------------------------------------------------------
  function resetToGameHome() {
    net.clearSession();
    net.leave();
    state.roomCode = null;
    state.role = null;
    state.token = null;
    state.started = false;
    state.gameOver = false;
    state.turn = null;
    state.ready = false;
    state.placed = {};
    state.shipCells = new Set();
    state.myShots = [];
    state.incomingShots = [];
    Twoplay.hideBanner();
    $("join-code").value = "";
    showScreen("home");
  }

  function newGame() {
    const inProgress = state.started && !state.gameOver;
    if (inProgress && !confirm("Leave this game and start a new one?")) return;
    net.send({ type: "leave_room" });
    resetToGameHome();
  }

  function goToArcadeHome(e) {
    if (e) e.preventDefault();
    const inProgress = state.started && !state.gameOver;
    if (inProgress && !confirm("Leave this game and return to Twoplay home?")) return;
    net.send({ type: "leave_room" });
    net.clearSession();
    setTimeout(() => (location.href = "/"), 60);
  }

  // ---- Wire up ----------------------------------------------------------
  $("btn-create").addEventListener("click", () => {
    const grid_size = parseInt($("grid-size").value, 10);
    const turn_rule = $("turn-rule").value;
    net.connect();
    net.send({ type: "create_room", game_type: GAME_TYPE, grid_size, turn_rule });
  });

  $("btn-join").addEventListener("click", () => {
    const code = $("join-code").value.trim().toUpperCase();
    if (!code) {
      Twoplay.banner("Enter a room code to join.", "error");
      return;
    }
    net.connect();
    net.send({ type: "join_room", game_type: GAME_TYPE, room_code: code });
  });

  $("join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-join").click();
  });

  $("btn-copy").addEventListener("click", () => Twoplay.copyText(state.roomCode, $("btn-copy")));
  $("btn-rotate").addEventListener("click", rotate);
  $("btn-reset-ships").addEventListener("click", initPlacement);
  $("btn-ready").addEventListener("click", submitPlacement);
  $("btn-newgame").addEventListener("click", newGame);
  $("brand-home").addEventListener("click", goToArcadeHome);

  $("btn-play-again").addEventListener("click", () => {
    $("btn-play-again").disabled = true;
    $("play-again-status").classList.remove("hidden");
    net.send({ type: "play_again" });
  });

  // ---- Startup ----------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const preRoom = params.get("room");
  if (preRoom) {
    net.clearSession();
    $("join-code").value = preRoom.toUpperCase();
    showScreen("home");
  } else if (net.loadSession()) {
    Twoplay.banner("Reconnecting to your game…", "warn");
    net.doReconnect();
  } else {
    showScreen("home");
  }
})();
