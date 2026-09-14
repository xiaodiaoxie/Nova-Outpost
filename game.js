  const GRID_SIZE = 128;
  const CELL_SIZE = 32;
  const WAREHOUSE_RADIUS = 10; 
  
  // Game Config State
  const gameConfig = { oreDensity: 0.5, waveCount: 100 };
  const globalState = { metal: 100 }; // Initial 100 Metal

  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  
  const state = {
    scale: 1,
    panX: window.innerWidth / 2 - (GRID_SIZE * CELL_SIZE) / 2,
    panY: window.innerHeight / 2 - (GRID_SIZE * CELL_SIZE) / 2,
    isDragging: false,
    lastMouseX: 0, lastMouseY: 0,
    currentTool: null,
    selectedCell: null,
    hoverCell: null,
    gridData: new Map(),
    oreMap: new Map(),
    base: { x: Math.floor(GRID_SIZE / 2), y: Math.floor(GRID_SIZE / 2), radius: 10 },
    // 连线统一存放：{ from, to, kind } —— 方向由玩家点击顺序决定
    links: [],
    connectMode: false,
    connectSource: null, 
    needsRedraw: true,
    lastTime: 0
  };

  const BUILDING_INFO = {
    miner:   { name: '采矿机', icon: '⛏', color: '#ffaa00', bg: 'rgba(255, 170, 0, 0.2)', desc: '从所在矿脉提取资源，每秒产出1个矿石。必须连线【采矿机 → 中转站】才会工作，未连线时完全停产。' },
    furnace: { name: '熔炼炉', icon: '🔥', color: '#ff3c3c', bg: 'rgba(255, 60, 60, 0.2)', desc: '消耗1金属矿+1煤矿，产出1金属锭。连线：中转站→熔炉 送原料；熔炉→中转站 回收金属锭；熔炉→基地 金属锭直接入库存。' },
    factory: { name: '制造机', icon: '🏭', color: '#3c78ff', bg: 'rgba(60, 120, 255, 0.2)', desc: '高级自动化组装线（暂未实装配方）。' },
    warehouse: { name: '中转站', icon: '📦', color: '#64ff64', bg: 'rgba(100, 255, 100, 0.2)', desc: '物流枢纽，自身不采集资源。按 Q 手动连线：采矿机→中转站（送矿）、中转站→熔炉（供料）、熔炉→中转站（回收锭）、中转站→基地（锭入库存）。' },
    powerplant: { name: '火力发电站', icon: '🔌', color: '#4de3ff', bg: 'rgba(77, 227, 255, 0.2)', desc: '只能建在煤矿上。每秒产出 10 点电量，汇入基地电量池，供电磁狙击塔开火。' }
  };

  const COSTS = { miner: 10, warehouse: 50, furnace: 30, factory: 20, powerplant: 100 };

  // 连线种类：点击顺序决定流向
  const LINK_KINDS = {
    collect:  { name: '采集', color: '#d4a373', desc: '采矿机 → 中转站' },
    supply:   { name: '供料', color: '#ffffff', desc: '中转站 → 熔炉' },
    ret:      { name: '回收', color: '#ffd700', desc: '熔炉 → 中转站' },
    whToBase: { name: '入库', color: '#ffd700', desc: '中转站 → 基地' },
    fnToBase: { name: '入库', color: '#ffd700', desc: '熔炉 → 基地' }
  };

  const viewport = document.getElementById('viewport');
  const uiPanel = document.getElementById('ui-panel');
  const toolbar = document.getElementById('toolbar');
  const coordsEl = document.getElementById('coords');
  const toast = document.getElementById('toast');
  const modeIndicator = document.getElementById('mode-indicator');
  const storageSection = document.getElementById('storage-section');
  const furnaceSection = document.getElementById('furnace-section');
  const globalMetalEl = document.getElementById('global-metal');
  const toolbarMetalEl = document.getElementById('toolbar-metal');
  const startScreen = document.getElementById('start-screen');
  const densitySlider = document.getElementById('density-slider');
  const densityVal = document.getElementById('density-val');
  const btnStart = document.getElementById('btn-start');
  const waveCountSlider = document.getElementById('wavecount-slider');
  const waveCountVal = document.getElementById('wavecount-val');

  // 待建属性面板（位于建造工具栏内，按下建造按钮后显示）
  const buildPreview = document.getElementById('build-preview');
  const bpIcon = document.getElementById('bp-icon');
  const bpName = document.getElementById('bp-name');
  const bpCost = document.getElementById('bp-cost');
  const bpGrid = document.getElementById('bp-grid');
  const bpDesc = document.getElementById('bp-desc');

  if (waveCountSlider) {
    gameConfig.waveCount = parseInt(waveCountSlider.value);
    waveCountSlider.addEventListener('input', (e) => {
      gameConfig.waveCount = parseInt(e.target.value);
      waveCountVal.textContent = gameConfig.waveCount;
    });
  }

  // --- Start Screen Logic ---
  densitySlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    gameConfig.oreDensity = val;
    densityVal.textContent = val.toFixed(1) + '%';
  });

  btnStart.addEventListener('click', () => {
    startScreen.style.display = 'none';
    viewport.style.display = 'block';
    init();
  });

  function init() {
    resizeCanvas();
    generateMap(gameConfig.oreDensity);
    updateGlobalUI();
    requestAnimationFrame(renderLoop);
    showToast("地图生成完成！按 E 开始建造");
    setTimeout(() => toast.classList.add('hidden'), 2000);
  }

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    state.needsRedraw = true;
  }
  window.addEventListener('resize', resizeCanvas);

  function generateMap(densityPercent) {
    const bx = state.base.x; const by = state.base.y; const r = state.base.radius;
    const prob = densityPercent / 100;
    state.oreMap.clear();

    placeOreInArea(bx, by, r, 'metal');
    placeOreInArea(bx, by, r, 'coal');

    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (state.oreMap.has(`${x},${y}`)) continue;
        const rand = Math.random();
        if (rand < prob / 2) state.oreMap.set(`${x},${y}`, 'metal');
        else if (rand < prob) state.oreMap.set(`${x},${y}`, 'coal');
      }
    }
  }

  function placeOreInArea(cx, cy, radius, type) {
    let attempts = 0;
    while (attempts < 100) {
      const rx = cx + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
      const ry = cy + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
      if (rx >= 0 && rx < GRID_SIZE && ry >= 0 && ry < GRID_SIZE) {
        const key = `${rx},${ry}`;
        if (!state.oreMap.has(key) && !(rx === cx && ry === cy)) {
          state.oreMap.set(key, type);
          return true;
        }
      }
      attempts++;
    }
    return false;
  }

  function renderLoop(timestamp) {
    const deltaTime = timestamp - state.lastTime;
    state.lastTime = timestamp;

    const _logicT0 = performance.now();
    updateLogic(deltaTime);
    updateAnimations(deltaTime);
    updateCombat(deltaTime);
    cbSampleLogic(performance.now() - _logicT0);

    if (state.needsRedraw || hasActiveAnimations()) {
      draw();
      state.needsRedraw = false;
    }
    
    if (uiPanel.classList.contains('visible') && state.selectedCell) {
      const data = state.gridData.get(`${state.selectedCell.x},${state.selectedCell.y}`);
      if (data) updatePanelContent(data);
    }

    requestAnimationFrame(renderLoop);
  }

  // ================= 生产与连线系统 =================
  // 连线统一存放在 state.links：{ from, to, kind, pulses }
  //   kind='collect'  中转站 → 采矿机（授权采集；矿石反向流入中转站）
  //   kind='supply'   中转站 → 熔炉（送入金属矿+煤矿）
  //   kind='ret'      熔炉 → 中转站（回收金属锭）
  //   kind='whToBase' 中转站 → 基地（金属锭入库存）
  //   kind='fnToBase' 熔炉 → 基地（金属锭入库存）
  // 点击顺序即连线方向，方向不同语义不同，这是连线系统的核心约定。

  const PRODUCTION_INTERVAL = 1000;   // 各生产环节每秒结算一次
  const PULSE_SPEED = 0.002;          // 流动脉冲速度（0→1）

  function cellPx(key) {
    const p = key.split(',');
    return { x: (+p[0]) * CELL_SIZE + CELL_SIZE / 2, y: (+p[1]) * CELL_SIZE + CELL_SIZE / 2 };
  }

  // 生成一个从 fromKey 流向 toKey 的流动脉冲，到达时执行 deliver 描述的动作
  function spawnPulse(link, fromKey, toKey, color, deliver) {
    const a = cellPx(fromKey), b = cellPx(toKey);
    if (!link.pulses) link.pulses = [];
    link.pulses.push({
      startX: a.x, startY: a.y, endX: b.x, endY: b.y,
      progress: 0, color, deliver
    });
    state.needsRedraw = true;
  }

  // 脉冲抵达终点后的资源入账
  function deliverPulse(p) {
    const d = p.deliver;
    if (!d) return;
    if (d.act === 'oreToWh') {
      const wh = state.gridData.get(d.whKey);
      if (!wh) return;
      if (d.oreType === 'coal') wh.storage.coal++;
      else wh.storage.metal++;
    } else if (d.act === 'ingotToWh') {
      const wh = state.gridData.get(d.whKey);
      if (wh) wh.storage.ingot++;
    } else if (d.act === 'ingotToBase') {
      globalState.metal++;
      updateGlobalUI();
    }
    // 'oreToFurnace' 在拉取当帧已直接计入 inputBuffer，脉冲仅作视觉表现
  }

  function updateLogic(dt) {
    // --- 采矿机：仅当存在以它为起点的 collect 连线时才工作 ---
    state.gridData.forEach((data, key) => {
      if (data.type !== 'miner') return;
      let link = null;
      for (const l of state.links) {
        if (l.kind === 'collect' && l.from === key) { link = l; break; }
      }
      data.linked = !!link;
      if (!link) { data.productionTimer = 0; return; }

      data.productionTimer += dt;
      if (data.productionTimer < PRODUCTION_INTERVAL) return;
      data.productionTimer -= PRODUCTION_INTERVAL;

      if (!state.gridData.has(link.to)) return;         // 中转站已被拆除
      const oreType = state.oreMap.get(key) || 'metal';
      // 矿石流向：采矿机 → 中转站，与连线方向一致
      spawnPulse(link, key, link.to, oreType === 'coal' ? '#7a7a7a' : '#d4a373',
        { act: 'oreToWh', whKey: link.to, oreType });
    });

    // --- 熔炼炉：供料 / 熔炼 / 出料 ---
    state.gridData.forEach((data, key) => {
      if (data.type !== 'furnace') return;

      // 供料：每秒尝试从 supply 连线的中转站拉取 1 金属矿 + 1 煤矿
      data.pullTimer += dt;
      if (data.pullTimer >= PRODUCTION_INTERVAL) {
        data.pullTimer -= PRODUCTION_INTERVAL;
        for (const link of state.links) {
          if (link.kind !== 'supply' || link.to !== key) continue;
          const wh = state.gridData.get(link.from);
          if (!wh || wh.storage.metal <= 0 || wh.storage.coal <= 0) continue;
          wh.storage.metal--;
          wh.storage.coal--;
          data.inputBuffer.metal++;
          data.inputBuffer.coal++;
          spawnPulse(link, link.from, key, '#ffffff', { act: 'oreToFurnace' });
          break;                                       // 每秒只拉一份
        }
      }

      // 熔炼：1 金属矿 + 1 煤矿 → 1 金属锭
      if (data.inputBuffer.metal >= 1 && data.inputBuffer.coal >= 1) {
        data.processTimer += dt;
        if (data.processTimer >= PRODUCTION_INTERVAL) {
          data.processTimer -= PRODUCTION_INTERVAL;
          data.inputBuffer.metal--;
          data.inputBuffer.coal--;
          data.outputBuffer.ingot++;
        }
      } else {
        data.processTimer = 0;
      }

      // 出料：优先走 ret 连线回中转站，其次走 fnToBase 直接入库存
      if (data.outputBuffer.ingot > 0) {
        data.outputPipeTimer += dt;
        if (data.outputPipeTimer >= PRODUCTION_INTERVAL) {
          data.outputPipeTimer -= PRODUCTION_INTERVAL;
          let ret = null, toBase = null;
          for (const l of state.links) {
            if (l.from !== key) continue;
            if (l.kind === 'ret' && !ret) ret = l;
            else if (l.kind === 'fnToBase' && !toBase) toBase = l;
          }
          if (ret && state.gridData.has(ret.to)) {
            data.outputBuffer.ingot--;
            spawnPulse(ret, key, ret.to, '#ffd700', { act: 'ingotToWh', whKey: ret.to });
          } else if (toBase) {
            data.outputBuffer.ingot--;
            spawnPulse(toBase, key, toBase.to, '#ffd700', { act: 'ingotToBase' });
          }
        }
      }
    });

    // --- 中转站：把回收到的金属锭送往基地 ---
    state.gridData.forEach((data, key) => {
      if (data.type !== 'warehouse' || data.storage.ingot <= 0) return;
      let link = null;
      for (const l of state.links) {
        if (l.kind === 'whToBase' && l.from === key) { link = l; break; }
      }
      if (!link) return;
      data.basePipeTimer = (data.basePipeTimer || 0) + dt;
      if (data.basePipeTimer < PRODUCTION_INTERVAL) return;
      data.basePipeTimer -= PRODUCTION_INTERVAL;
      data.storage.ingot--;
      spawnPulse(link, key, link.to, '#ffd700', { act: 'ingotToBase' });
    });
  }

  function hasActiveAnimations() {
    for (const link of state.links) {
      if (link.pulses && link.pulses.length > 0) return true;
    }
    return false;
  }

  function updateAnimations(dt) {
    for (const link of state.links) {
      if (!link.pulses) continue;
      for (let j = link.pulses.length - 1; j >= 0; j--) {
        const p = link.pulses[j];
        p.progress += PULSE_SPEED * dt;
        if (p.progress >= 1) {
          deliverPulse(p);
          link.pulses.splice(j, 1);
          state.needsRedraw = true;
        }
      }
    }
  }

  function draw() {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(state.panX, state.panY);
    ctx.scale(state.scale, state.scale);

    // Grid
    ctx.strokeStyle = '#1f1f1f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const totalSize = GRID_SIZE * CELL_SIZE;
    for (let i = 0; i <= GRID_SIZE; i++) {
      const pos = i * CELL_SIZE;
      ctx.moveTo(pos, 0); ctx.lineTo(pos, totalSize);
      ctx.moveTo(0, pos); ctx.lineTo(totalSize, pos);
    }
    ctx.stroke();

    // Build Area Highlight
    if (state.currentTool) {
      const r = state.base.radius;
      const startX = (state.base.x - r) * CELL_SIZE;
      const startY = (state.base.y - r) * CELL_SIZE;
      const size = (r * 2 + 1) * CELL_SIZE;
      ctx.fillStyle = 'rgba(100, 150, 255, 0.1)';
      ctx.fillRect(startX, startY, size, size);
      ctx.strokeStyle = 'rgba(100, 150, 255, 0.6)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(startX, startY, size, size);
      ctx.setLineDash([]);
    }

    // Ores
    ctx.font = '16px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    state.oreMap.forEach((type, key) => {
      const [x, y] = key.split(',').map(Number);
      const px = x * CELL_SIZE; const py = y * CELL_SIZE;
      if (type === 'metal') {
        ctx.fillStyle = 'rgba(180, 140, 100, 0.3)';
        ctx.fillRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        ctx.fillStyle = '#d4a373';
        ctx.fillText('🟫', px + CELL_SIZE/2, py + CELL_SIZE/2);
      } else if (type === 'coal') {
        ctx.fillStyle = 'rgba(50, 50, 50, 0.5)';
        ctx.fillRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        ctx.fillStyle = '#555';
        ctx.fillText('⬛', px + CELL_SIZE/2, py + CELL_SIZE/2);
      }
    });

    // Base
    const bx = state.base.x * CELL_SIZE;
    const by = state.base.y * CELL_SIZE;
    ctx.fillStyle = 'rgba(100, 200, 255, 0.2)';
    ctx.fillRect(bx + 1, by + 1, CELL_SIZE - 2, CELL_SIZE - 2);
    ctx.strokeStyle = '#64c8ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx + 1, by + 1, CELL_SIZE - 2, CELL_SIZE - 2);
    ctx.fillStyle = '#64c8ff';
    ctx.font = '20px Arial';
    ctx.fillText('🏰', bx + CELL_SIZE/2, by + CELL_SIZE/2);

    // Buildings
    state.gridData.forEach((data, key) => {
      const [x, y] = key.split(',').map(Number);
      const px = x * CELL_SIZE; const py = y * CELL_SIZE;
      const info = BUILDING_INFO[data.type];

      ctx.fillStyle = info.bg;
      ctx.fillRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      ctx.strokeStyle = info.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      ctx.fillStyle = info.color;
      ctx.font = '16px Arial';
      ctx.fillText(info.icon, px + CELL_SIZE/2, py + CELL_SIZE/2);

      if (data.type === 'miner' && !data.linked) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      }
      if (data.type === 'furnace' && data.processTimer > 0) {
         ctx.fillStyle = 'rgba(255, 100, 0, 0.5)';
         ctx.fillRect(px + 4, py + 4, (CELL_SIZE - 8) * (data.processTimer/1000), 4);
      }
    });

    // --- 连线与流动脉冲 ---
    // 每条连线画成带方向箭头的线，箭头指向 to，明确「谁流向谁」
    for (const link of state.links) {
      const a = cellPx(link.from === BASE_KEY ? `${state.base.x},${state.base.y}` : link.from);
      const b = cellPx(link.to === BASE_KEY ? `${state.base.x},${state.base.y}` : link.to);
      const kind = LINK_KINDS[link.kind] || { color: '#888' };

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = kind.color;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // 方向箭头：画在线段中点，指向 to
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const hs = 7;
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(ang) * hs, my + Math.sin(ang) * hs);
      ctx.lineTo(mx + Math.cos(ang + 2.5) * hs, my + Math.sin(ang + 2.5) * hs);
      ctx.lineTo(mx + Math.cos(ang - 2.5) * hs, my + Math.sin(ang - 2.5) * hs);
      ctx.closePath();
      ctx.fillStyle = kind.color;
      ctx.fill();

      // 流动脉冲（采集线的矿石实际是反向流动，用脉冲自身的起终点绘制）
      if (link.pulses) {
        for (const p of link.pulses) {
          const cx = p.startX + (p.endX - p.startX) * p.progress;
          const cy = p.startY + (p.endY - p.startY) * p.progress;
          ctx.beginPath();
          ctx.arc(cx, cy, 4, 0, Math.PI * 2);
          ctx.fillStyle = p.color;
          ctx.shadowColor = p.color;
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
    }

    // --- 连线模式：起点 → 悬停格 的预览虚线 ---
    if (state.connectMode && state.connectSource && state.hoverCell) {
      const a = cellPx(state.connectSource.key);
      const b = cellPx(`${state.hoverCell.x},${state.hoverCell.y}`);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#64ff64';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Hover / Selection / Preview
    if (state.hoverCell) {
      const {x, y} = state.hoverCell;
      const px = x * CELL_SIZE; const py = y * CELL_SIZE;
      
      const showRange = (state.currentTool === 'warehouse') || (state.selectedCell && state.gridData.get(`${state.selectedCell.x},${state.selectedCell.y}`)?.type === 'warehouse');
      if (showRange) {
         const cx = state.currentTool === 'warehouse' ? x : state.selectedCell.x;
         const cy = state.currentTool === 'warehouse' ? y : state.selectedCell.y;
         const r = WAREHOUSE_RADIUS;
         const rangePxX = (cx - r) * CELL_SIZE;
         const rangePxY = (cy - r) * CELL_SIZE;
         const rangeSizePx = (r * 2 + 1) * CELL_SIZE;

         ctx.strokeStyle = 'rgba(100, 255, 100, 0.5)';
         ctx.lineWidth = 2;
         ctx.setLineDash([6, 6]);
         ctx.strokeRect(rangePxX, rangePxY, rangeSizePx, rangeSizePx);
         ctx.setLineDash([]);
         ctx.fillStyle = 'rgba(100, 255, 100, 0.05)';
         ctx.fillRect(rangePxX, rangePxY, rangeSizePx, rangeSizePx);
      }

      if (state.currentTool) {
        const check = canPlaceBuilding(x, y, state.currentTool);
        if (!check.ok) {
          ctx.fillStyle = 'rgba(255, 50, 50, 0.3)';
          ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
          ctx.strokeStyle = 'rgba(255, 50, 50, 0.8)';
          ctx.lineWidth = 2;
          ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        } else {
          ctx.fillStyle = BUILDING_INFO[state.currentTool].bg;
          ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
          ctx.globalAlpha = 0.5;
          ctx.fillText(BUILDING_INFO[state.currentTool].icon, px + CELL_SIZE/2, py + CELL_SIZE/2);
          ctx.globalAlpha = 1.0;
        }
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
      }

      if (state.connectMode && state.connectSource) {
         if (x !== state.connectSource.x || y !== state.connectSource.y) {
           ctx.strokeStyle = '#64ff64';
           ctx.lineWidth = 2;
           ctx.shadowColor = '#64ff64';
           ctx.shadowBlur = 10;
           ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
           ctx.shadowBlur = 0;
         }
      }
    }

    if (state.selectedCell) {
      const {x, y} = state.selectedCell;
      const px = x * CELL_SIZE; const py = y * CELL_SIZE;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
    }

    if (state.connectSource) {
      const {x, y} = state.connectSource;
      const px = x * CELL_SIZE; const py = y * CELL_SIZE;
      ctx.strokeStyle = '#64ff64';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
    }

    drawCombat();
    ctx.restore();
    drawCombatHUD();
  }

  function getGridCoord(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;
    const worldX = (mouseX - state.panX) / state.scale;
    const worldY = (mouseY - state.panY) / state.scale;
    const gx = Math.floor(worldX / CELL_SIZE);
    const gy = Math.floor(worldY / CELL_SIZE);
    if (gx >= 0 && gx < GRID_SIZE && gy >= 0 && gy < GRID_SIZE) return { x: gx, y: gy };
    return null;
  }

  canvas.addEventListener('mousemove', (e) => {
    if (state.isDragging) {
      state.panX += e.clientX - state.lastMouseX;
      state.panY += e.clientY - state.lastMouseY;
      state.lastMouseX = e.clientX;
      state.lastMouseY = e.clientY;
      state.needsRedraw = true;
      const coord = getGridCoord(e.clientX, e.clientY);
      if (coord) coordsEl.textContent = `Pos: ${coord.x}, ${coord.y} | Zoom: ${Math.round(state.scale * 100)}%`;
      return;
    }
    const coord = getGridCoord(e.clientX, e.clientY);
    if (coord && (!state.hoverCell || coord.x !== state.hoverCell.x || coord.y !== state.hoverCell.y)) {
      state.hoverCell = coord;
      state.needsRedraw = true;
    } else if (!coord && state.hoverCell) {
      state.hoverCell = null;
      state.needsRedraw = true;
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1) { 
      e.preventDefault();
      state.isDragging = true;
      state.lastMouseX = e.clientX;
      state.lastMouseY = e.clientY;
      viewport.style.cursor = 'grabbing';
      return;
    }
    if (e.button === 0) {
      const coord = getGridCoord(e.clientX, e.clientY);
      if (coord) handleCellClick(coord);
    }
  });

  window.addEventListener('mouseup', () => {
    if (state.isDragging) {
      state.isDragging = false;
      viewport.style.cursor = state.currentTool || state.connectMode ? 'crosshair' : 'default';
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomIntensity = 0.1;
    const delta = e.deltaY > 0 ? -zoomIntensity : zoomIntensity;
    const newScale = Math.min(Math.max(0.2, state.scale + delta), 3);
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const worldX = (mouseX - state.panX) / state.scale;
    const worldY = (mouseY - state.panY) / state.scale;
    state.scale = newScale;
    state.panX = mouseX - worldX * state.scale;
    state.panY = mouseY - worldY * state.scale;
    state.needsRedraw = true;
    coordsEl.textContent = `Zoom: ${Math.round(state.scale * 100)}%`;
  }, { passive: false });

  // 连线规则：点击顺序决定流向
  //   采矿机 → 中转站 : collect   授权采集，矿石送入中转站
  //   中转站 → 熔炉   : supply    把配比好的金属矿+煤矿送入熔炉
  //   熔炉   → 中转站 : ret       把熔炼好的金属锭转回中转站
  //   中转站 → 基地   : whToBase  中转站的金属锭入库存
  //   熔炉   → 基地   : fnToBase  熔炉的金属锭直接入库存
  const LINK_RULES = [
    { from: 'miner',     to: 'warehouse', kind: 'collect',  msg: '采集连线：采矿机开始工作，矿石送往中转站' },
    { from: 'warehouse', to: 'furnace',   kind: 'supply',   msg: '供料连线：中转站把金属矿+煤矿送入熔炉' },
    { from: 'furnace',   to: 'warehouse', kind: 'ret',      msg: '回收连线：熔炉把金属锭转回中转站' },
    { from: 'warehouse', to: 'base',      kind: 'whToBase', msg: '入库连线：中转站的金属锭直接入基地库存' },
    { from: 'furnace',   to: 'base',      kind: 'fnToBase', msg: '入库连线：熔炉的金属锭直接入基地库存' }
  ];

  const BASE_KEY = 'base';

  function isBaseCell(x, y) {
    return x === state.base.x && y === state.base.y;
  }

  // 找出符合「起点类型 → 终点类型」的规则；返回 null 表示这是无效组合
  function matchLinkRule(fromType, toType) {
    for (const r of LINK_RULES) {
      if (r.from === fromType && r.to === toType) return r;
    }
    return null;
  }

  function handleCellClick(coord) {
    const {x, y} = coord;
    const key = `${x},${y}`;
    const existing = state.gridData.get(key);
    const isBase = isBaseCell(x, y);

    if (state.connectMode) {
      const clickType = existing ? existing.type : (isBase ? BASE_KEY : null);
      if (!clickType) { showToast('只能连接已有的建筑或基地'); return; }

      // --- 第一次点击：选起点 ---
      if (!state.connectSource) {
        if (!LINK_RULES.some(r => r.from === clickType)) {
          showToast('连线起点必须是【采矿机】【中转站】或【熔炼炉】');
          return;
        }
        state.connectSource = { x, y, key, type: clickType };
        showToast(`起点：${BUILDING_INFO[clickType].name} → 请点击目标（顺序决定流向）`);
        state.needsRedraw = true;
        return;
      }

      const src = state.connectSource;

      // --- 再次点击起点：取消 ---
      if (src.key === key) {
        state.connectSource = null;
        showToast('已取消连线起点');
        state.needsRedraw = true;
        return;
      }

      // --- 第二次点击：按方向匹配规则 ---
      const rule = matchLinkRule(src.type, clickType);
      if (!rule) {
        showToast(`无效连线：${BUILDING_INFO[src.type].name} → ${isBase ? '基地' : BUILDING_INFO[clickType].name}`);
        state.needsRedraw = true;
        return;
      }

      // 同类型连线只允许一条，避免重复建线
      const toKey = isBase ? BASE_KEY : key;
      const dup = state.links.some(l => l.from === src.key && l.to === toKey && l.kind === rule.kind);
      if (dup) {
        showToast('这条连线已存在');
        state.connectSource = null;
        state.needsRedraw = true;
        return;
      }

      state.links.push({ from: src.key, to: toKey, kind: rule.kind, pulses: [] });
      showToast(rule.msg);
      state.connectSource = null;
      state.needsRedraw = true;
      return;
    }

    if (state.currentTool) {
      const check = canPlaceBuilding(x, y, state.currentTool);
      if (!check.ok) {
        showToast(check.msg);
        return;
      }
      placeBuilding(x, y, state.currentTool);
    } 
    else {
      if (existing) {
        selectBuilding({x, y}, existing);
      } else if (isBase) {
        cbShowBasePanel();
      } else {
        closeUI();
      }
    }
  }

  function placeBuilding(x, y, type) {
    const cost = COSTS[type];
    if (globalState.metal < cost) {
      showToast("金属不足！");
      return;
    }
    
    globalState.metal -= cost;
    updateGlobalUI();

    const id = Date.now() + Math.random();
    // 连线关系统一存放在 state.links，建筑自身只保留生产与缓存状态
    const data = {
      type, id,
      storage: { metal: 0, coal: 0, ingot: 0 },
      // 采矿机
      linked: false,             // 是否已有 中转站→本机 的采集连线
      productionTimer: 0,
      // 熔炼炉
      inputBuffer: { metal: 0, coal: 0 },
      outputBuffer: { ingot: 0 },
      processTimer: 0,
      pullTimer: 0,              // 拉取原料计时器
      outputPipeTimer: 0,        // 出料计时器
      // 中转站
      basePipeTimer: 0           // 送锭入库存计时器
    };
    state.gridData.set(`${x},${y}`, data);
    state.needsRedraw = true;
    showToast(`建造成功！消耗 ${cost} 金属`);
  }

  // 统计某建筑的连线：out = 以它为起点的连线数，in = 以它为终点的连线数
  function linkCounts(key) {
    let out = 0, inc = 0;
    for (const l of state.links) {
      if (l.from === key) out++;
      if (l.to === key) inc++;
    }
    return { out, inc };
  }

  function selectBuilding(cellInfo, data) {
    state.selectedCell = cellInfo;
    const info = BUILDING_INFO[data.type];
    document.getElementById('info-type').textContent = info.name;
    document.getElementById('info-coords').textContent = `${cellInfo.x}, ${cellInfo.y}`;
    
    const statusEl = document.getElementById('info-status');
    const key = `${cellInfo.x},${cellInfo.y}`;
    const lc = linkCounts(key);
    if (data.type === 'miner') {
      statusEl.textContent = data.linked ? '● 运行中 (已被中转站采集)' : '○ 闲置 (未连线采集)';
      statusEl.style.color = data.linked ? '#6f6' : '#f66';
    } else if (data.type === 'warehouse') {
      statusEl.textContent = `● 运行中 (输出 ${lc.out} 条 / 输入 ${lc.inc} 条)`;
      statusEl.style.color = (lc.out + lc.inc) > 0 ? '#6f6' : '#fc4';
    } else if (data.type === 'furnace') {
       statusEl.textContent = `● 运行中 (输入 ${lc.inc} 条 / 输出 ${lc.out} 条)`;
       statusEl.style.color = lc.inc > 0 ? '#6f6' : '#f66';
    } else if (data.type === 'powerplant') {
      statusEl.textContent = '● 运行中 (每秒 +10 电量)';
      statusEl.style.color = '#6f6';
    } else {
      statusEl.textContent = '● 运行中';
      statusEl.style.color = '#6f6';
    }
    
    if (data.type === 'warehouse') {
      storageSection.style.display = 'block';
      furnaceSection.style.display = 'none';
      document.getElementById('info-storage-metal').textContent = data.storage.metal;
      document.getElementById('info-storage-coal').textContent = data.storage.coal;
      document.getElementById('info-storage-ingot').textContent = data.storage.ingot;
    } else if (data.type === 'furnace') {
      storageSection.style.display = 'none';
      furnaceSection.style.display = 'block';
      document.getElementById('info-furnace-input').textContent = `${data.inputBuffer.metal} / ${data.inputBuffer.coal}`;
      document.getElementById('info-furnace-output').textContent = data.outputBuffer.ingot;
    } else {
      storageSection.style.display = 'none';
      furnaceSection.style.display = 'none';
    }

    cbHideBasePanel();
    document.getElementById('panel-title').textContent = '建筑详情';
    document.getElementById('info-desc').textContent = info.desc;
    cbSyncTurretPanel(data);
    document.getElementById('btn-demolish').onclick = () => demolishBuilding(cellInfo.x, cellInfo.y);
    uiPanel.classList.add('visible');
    state.needsRedraw = true;
  }

  function closeUI() {
    if (typeof cbHideBasePanel === 'function') cbHideBasePanel();
    uiPanel.classList.remove('visible');
    state.selectedCell = null;
    state.needsRedraw = true;
  }

  function demolishBuilding(x, y) {
    const key = `${x},${y}`;
    const data = state.gridData.get(key);
    if (!data) return;

    const cost = COSTS[data.type];
    globalState.metal += Math.floor(cost * 0.5);
    updateGlobalUI();

    // 清理所有以该建筑为起点或终点的连线，避免留下悬空连线
    const before = state.links.length;
    state.links = state.links.filter(l => l.from !== key && l.to !== key);
    const removed = before - state.links.length;

    state.gridData.delete(key);

    // 采矿机被拆后，其它建筑的 linked 标记会在下一帧 updateLogic 中重算
    closeUI();
    state.needsRedraw = true;
    if (removed > 0) showToast(`已拆除，同时移除 ${removed} 条连线`);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'e') {
      toolbar.classList.toggle('visible');
      if (!toolbar.classList.contains('visible')) exitEditMode();
    }
    if (e.key.toLowerCase() === 'q') toggleConnectMode();
    if (e.key === 'Escape') {
      closeUI(); exitEditMode();
      if (state.connectMode) toggleConnectMode();
    }
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    exitEditMode(); closeUI();
    if (state.connectMode) toggleConnectMode();
  });

  function toggleConnectMode() {
    state.connectMode = !state.connectMode;
    if (state.connectMode) {
      modeIndicator.classList.add('active');
      viewport.style.cursor = 'crosshair';
      exitEditMode(); state.connectSource = null;
      // 连线时关闭右侧详情面板与下方建造工具栏，避免遮挡
      closeUI();
      toolbar.classList.remove('visible');
      showToast("连线模式：先点起点再点终点，顺序决定流向（如 采矿机→中转站 送矿；中转站→熔炉 供料；熔炉→中转站 回收金属锭）");
    } else {
      modeIndicator.classList.remove('active');
      viewport.style.cursor = 'default';
      state.connectSource = null;
    }
    state.needsRedraw = true;
  }

  // 非炮塔设施的属性行（炮塔从 combat.js 的 TURRET_STATS 派生，保持单一数据源）
  const BUILD_STATS = {
    miner:     [['产出', '1 矿石 / 秒'], ['前提', '需连线到中转站'], ['未连线', '完全停产']],
    warehouse: [['作用', '物流枢纽'], ['自身', '不采集资源'], ['间距', '无限制，可紧邻建造']],
    furnace:   [['配方', '1 金属矿 + 1 煤矿'], ['产出', '1 金属锭'], ['供料', '需中转站连线']],
    powerplant:[['产出', '10 电量 / 秒'], ['地基', '只能建在煤矿上'], ['用途', '供电磁狙击塔开火']],
    factory:   [['状态', '暂未实装配方'], ['造价', '20 🟡']]
  };

  // 渲染待建属性面板：显示当前要建造的设施的完整属性
  function renderBuildPreview(type) {
    if (!buildPreview || !type) return;
    const info = BUILDING_INFO[type];
    if (!info) return;

    bpIcon.textContent = info.icon;
    bpName.textContent = info.name;

    const cost = COSTS[type];
    bpCost.textContent = `${cost} 🟡`;
    bpCost.classList.toggle('insufficient', globalState.metal < cost);

    const rows = [];
    const ts = (typeof TURRET_STATS !== 'undefined') ? TURRET_STATS : null;
    if (ts && ts[type]) {
      const s = ts[type];
      rows.push(['血量', s.hp]);
      rows.push(['伤害', s.damage]);
      rows.push(['射速', (1000 / s.fireInterval).toFixed(s.fireInterval < 100 ? 0 : 1) + ' 发/秒']);
      rows.push(['射程', `${s.minRange / CELL_SIZE}~${s.maxRange / CELL_SIZE} 格`]);
      if (s.blastRadius) rows.push(['爆炸半径', s.blastRadius]);
      if (s.powerCost) rows.push(['耗电', s.powerCost + ' ⚡/发']);
    } else if (BUILD_STATS[type]) {
      rows.push(...BUILD_STATS[type]);
    }

    bpGrid.innerHTML = rows
      .map(r => `<div class="bp-stat"><span>${r[0]}</span><b>${r[1]}</b></div>`)
      .join('');
    bpDesc.textContent = info.desc;
    buildPreview.classList.add('visible');
  }

  function hideBuildPreview() {
    if (buildPreview) buildPreview.classList.remove('visible');
  }

  function enterEditMode(type) {
    state.currentTool = type;
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === type));
    viewport.style.cursor = 'crosshair';
    renderBuildPreview(type);
    state.needsRedraw = true;
  }

  function exitEditMode() {
    state.currentTool = null;
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
    viewport.style.cursor = 'default';
    hideBuildPreview();
    state.needsRedraw = true;
  }

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = btn.dataset.type;
      if (state.currentTool === type) exitEditMode();
      else enterEditMode(type);
    });
  });

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3000);
  }

  function updateGlobalUI() {
    globalMetalEl.textContent = globalState.metal;
    toolbarMetalEl.textContent = globalState.metal;
    
    document.querySelectorAll('.tool-btn').forEach(btn => {
      const cost = parseInt(btn.dataset.cost);
      if (globalState.metal < cost) {
        btn.classList.add('disabled');
      } else {
        btn.classList.remove('disabled');
      }
    });

    // 待建面板开着时，同步刷新造价是否足够的提示
    if (buildPreview && buildPreview.classList.contains('visible') && state.currentTool) {
      const cost = COSTS[state.currentTool];
      if (cost !== undefined && bpCost) {
        bpCost.classList.toggle('insufficient', globalState.metal < cost);
      }
    }
  }

  function updatePanelContent(data) {
     if (data.type === 'warehouse') {
      document.getElementById('info-storage-metal').textContent = data.storage.metal;
      document.getElementById('info-storage-coal').textContent = data.storage.coal;
      document.getElementById('info-storage-ingot').textContent = data.storage.ingot;
     } else if (data.type === 'furnace') {
      document.getElementById('info-furnace-input').textContent = `${data.inputBuffer.metal} / ${data.inputBuffer.coal}`;
      document.getElementById('info-furnace-output').textContent = data.outputBuffer.ingot;
     }
     cbSyncTurretPanel(data);
  }

  function canPlaceBuilding(x, y, type) {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return { ok: false, msg: "超出地图边界" };
    if (state.gridData.has(`${x},${y}`)) return { ok: false, msg: "此处已有建筑" };
    if (x === state.base.x && y === state.base.y) return { ok: false, msg: "这里是指挥中心" };
    
    const dx = Math.abs(x - state.base.x);
    const dy = Math.abs(y - state.base.y);
    if (dx > state.base.radius || dy > state.base.radius) {
       return { ok: false, msg: "超出基地控制范围" };
    }

    if (type === 'miner') {
      if (!state.oreMap.has(`${x},${y}`)) return { ok: false, msg: "此处没有矿脉" };
    }

    // 火力发电站：只能建在煤矿上
    if (type === 'powerplant') {
      if (state.oreMap.get(`${x},${y}`) !== 'coal') {
        return { ok: false, msg: "火力发电站只能建在煤矿 ⬛ 上" };
      }
    }
    
    // 中转站之间不再有间距限制，可以紧邻建造
    
    if (globalState.metal < COSTS[type]) {
      return { ok: false, msg: `金属不足 (需要 ${COSTS[type]})` };
    }

    return { ok: true };
  }