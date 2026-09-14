/* =========================================================
 * combat.js — 炮塔 / 尸群 / 波次时间系统
 *
 * 与 game.js 共享同一全局词法作用域（同页两个 <script>），
 * 因此可直接复用 state / ctx / canvas / CELL_SIZE / BUILDING_INFO / COSTS。
 * 本文件新增的全局名统一带 cb / CB_ / combat / TURRET_STATS / MONSTER_ 前缀。
 *
 * 坐标约定：怪物与炮塔都在「世界像素空间」，与 canvas 的
 * translate(panX,panY) + scale(scale) 一致；格子 (gx,gy) 中心为
 * gx*CELL_SIZE + CELL_SIZE/2。所以战斗层可直接叠在网格渲染之上。
 *
 * 性能要点：
 *  1) 怪物斥力用空间哈希（3×3 邻域），避免 3000² 的两两比较；
 *  2) 子弹碰撞同样走空间哈希，避免逐发全量扫描；
 *  3) emoji 预渲染为精灵图 + 视口裁剪，避免每帧数千次 fillText；
 *  4) 死亡怪物在物理循环结束后统一压缩，循环内不 splice，
 *     以保证哈希索引在整个物理阶段始终有效。
 * ========================================================= */

// ---------- 炮塔参数（三种） ----------
// 射程按「格半径」给定，× CELL_SIZE 换算为世界像素，与基地半径同一单位口径
// turretShell  : 范围攻击塔，抛物线炮弹 + 落点范围爆炸
// turretBullet : 机枪塔，直线高速子弹，发射后不跟踪
// turretSniper : 电磁狙击塔，锁定即命中（无弹道），每次开火耗电
const CB_RANGE_CELL = CELL_SIZE;   // 1 格 = 32px

const TURRET_STATS = {
  turretShell: {
    name: '范围攻击塔', icon: '💥', color: '#3c78ff', bg: 'rgba(60, 120, 255, 0.22)',
    hp: 1000, fireInterval: 500, damage: 20,
    minRange: 3 * CB_RANGE_CELL, maxRange: 8 * CB_RANGE_CELL,
    projectile: 'shell', blastRadius: 50, powerCost: 0,
    desc: '抛物线炮弹，锁定发射时目标位置为落点，落点范围爆炸(半径50)。伤害20 / 2发每秒 / 射程3~8格 / 血量1000。擅长清理密集尸群。'
  },
  turretBullet: {
    name: '机枪塔', icon: '⚡', color: '#b464ff', bg: 'rgba(180, 100, 255, 0.22)',
    hp: 1000, fireInterval: 50, damage: 30,
    minRange: 1 * CB_RANGE_CELL, maxRange: 10 * CB_RANGE_CELL,
    projectile: 'bullet', blastRadius: 0, powerCost: 0,
    desc: '直线高速子弹，发射瞬间定向后不再跟踪，飞出射程即消失。伤害30 / 20发每秒 / 射程1~10格 / 血量1000。持续压制。'
  },
  turretSniper: {
    name: '电磁狙击塔', icon: '🎯', color: '#4de3ff', bg: 'rgba(77, 227, 255, 0.2)',
    hp: 1000, fireInterval: 1000, damage: 100,
    minRange: 5 * CB_RANGE_CELL, maxRange: 20 * CB_RANGE_CELL,
    projectile: 'hitscan', blastRadius: 0, powerCost: 5,
    desc: '直接锁定一个单位，开枪瞬间命中，无弹道飞行。伤害100 / 1发每秒 / 射程5~20格 / 血量1000。每次开火耗电 5。'
  }
};

// 并入既有建筑表：建造、详情面板、拆除返还、造价置灰全部自动复用
Object.assign(BUILDING_INFO, {
  turretShell:  { name: TURRET_STATS.turretShell.name,  icon: TURRET_STATS.turretShell.icon,  color: TURRET_STATS.turretShell.color,  bg: TURRET_STATS.turretShell.bg,  desc: TURRET_STATS.turretShell.desc },
  turretBullet: { name: TURRET_STATS.turretBullet.name, icon: TURRET_STATS.turretBullet.icon, color: TURRET_STATS.turretBullet.color, bg: TURRET_STATS.turretBullet.bg, desc: TURRET_STATS.turretBullet.desc },
  turretSniper: { name: TURRET_STATS.turretSniper.name, icon: TURRET_STATS.turretSniper.icon, color: TURRET_STATS.turretSniper.color, bg: TURRET_STATS.turretSniper.bg, desc: TURRET_STATS.turretSniper.desc }
});
Object.assign(COSTS, { turretShell: 80, turretBullet: 60, turretSniper: 150 });

const WORLD_PX = GRID_SIZE * CELL_SIZE;        // 4096
const CB_BASE_MAX_HP = 10000;                  // 基地血量

// ---------- 怪物 / 波次参数 ----------
const MONSTER_HP       = 100;      // 基础血量，每 10 波 ×1.2
const MONSTER_RADIUS   = 6;        // 体积缩小 50%（原 12），碰撞半径同步
const MONSTER_MASS     = 1;
const MONSTER_DAMAGE   = 10;       // 伤害减少 50%（原 20）
const MONSTER_ATK_CD   = 1000;     // 攻击间隔(ms)：1 次/秒
const MONSTER_ATTRACT  = 0.075;    // 移动速度减少 50%（原 0.15）
const MONSTER_REPEL    = 0.3;      // 粒子间斥力强度
const MONSTER_DAMP     = 0.92;     // 每帧阻尼
const MONSTER_HP_STEP  = 1.2;      // 每 10 波血量倍率

// 第 wave 波的小怪血量：100 × 1.2^floor((wave-1)/10)
// 校验：第 21 波 → floor(20/10)=2 → 100×1.2² = 144
function cbMonsterHpFor(wave) {
  const w = Math.max(1, wave | 0);
  const steps = Math.floor((w - 1) / 10);
  return Math.round(MONSTER_HP * Math.pow(MONSTER_HP_STEP, steps));
}

const BOSS_RADIUS      = 40;
const BOSS_MASS        = 20;
// BOSS 血量 = 10000 + 波次×5000
function cbBossHpFor(wave) {
  return 10000 + Math.max(0, wave | 0) * 5000;
}

// 存活上限改为「帧率门控」：FPS < 60 停止生成，>= 60 继续，每秒判定一次
const CB_FPS_TARGET     = 60;
const CB_FPS_CHECK_MS   = 1000;
// 寻路：距基地超过 CB_TURRET_SEEK_CELLS 格内无炮塔则直奔基地，1s 重判一次
const CB_TURRET_SEEK_CELLS = 6;
const CB_TURRET_SEEK_PX    = CB_TURRET_SEEK_CELLS * CELL_SIZE;   // 192px
const CB_RETARGET_MS       = 1000;

const WAVE_INTERVAL      = 180000; // 3 分钟一波
const WAVE_WARN_MS       = 30000;  // 波次到来前 30s 预警
const CB_WAVE_COUNT_MIN  = 50;     // 开局可调节的每波基数范围
const CB_WAVE_COUNT_MAX  = 200;
const CB_SPAWN_MARGIN    = 150;    // 地图外生成余量
const CB_SPAWN_DEPTH     = 420;    // 生成距离抖动，避免怪物排成一条整齐的线

// 出怪扇区半角（度）。8 个方位各占 45°，半角必须 < 22.5° 才不会越到相邻扇区，
// 否则「本波来自北/东南」的预警提示就失去意义。取 12° 让每一股更聚拢。
const CB_SPAWN_SPREAD_DEG = 12;

// 成潮泄流：一波怪物的总出怪时长 = (CB_SPAWN_BASE_SEC + 波次) 秒。
// 每秒应生成 = 本波总数 / 总时长；换算到每帧若 > 1 只，则按用户要求把
// 1.01~1.99 这类小数直接进位为整数（ceil），避免每帧生成非整数只。
const CB_SPAWN_BASE_SEC  = 9;
const CB_SPAWN_FRAME_MS  = 1000 / 60;   // 均分基准：按 60fps 折算每帧配额

// 8 个方位（N, NE, E, SE, S, SW, W, NW）
const CB_DIRS = [
  { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
  { x: 0, y: 1 },  { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 }
];
const CB_DIR_NAMES = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

// 每波来袭方向数 = ceil(波数 / 10)，上限 8
function cbWaveDirCount(wave) {
  return Math.min(CB_DIRS.length, Math.max(1, Math.ceil(wave / 10)));
}

// ---------- 战斗运行时状态 ----------
const combatState = {
  running: false,
  gameOver: false,
  baseHp: CB_BASE_MAX_HP,
  monsters: [],
  bullets: [],
  shells: [],
  beams: [],
  effects: [],
  dmgTexts: [],
  // 生成队列：存放「方向索引」，按方向轮转排列，出队时天然在各方向间交替，
  // 因此多方向来袭时数量自动平分、且是多股尸潮同时涌入而非逐个方向刷完
  spawnQueue: [],
  spawnIdx: 0,
  spawnCredit: 0,         // 配额累加器：<1 的小数部分留存到后续帧
  spawnQuota: 0,          // 每帧配额 = 本波总数 / (9+波次) 秒对应的总帧数
  wave: 0,
  waveTimer: WAVE_INTERVAL,
  waveWarned: false,
  waveDirs: [],           // 当前/下一波的来袭方向索引
  pendingBoss: 0,         // 待刷新的 BOSS 数量（每第 10 波 1 只，小怪出完后刷）
  bossSpawnDir: null,     // BOSS 从本波小怪的方向中随机挑一个进场
  elapsed: 0,
  kills: 0,
  time: 0,
  regenTimer: 0,
  powerTimer: 0,
  baseLevel: 1,           // 基地等级，1~5
  basePower: 0,           // 基地电量，初始 0，上限随等级翻倍
  fpsTimer: 0,            // 帧率门控计时器，每秒判定一次
  fps: 60,
  spawnAllowed: true,
  frameSamples: 0,
  logicMs: 0,             // 每逻辑帧运行用时（debug 显示）
  logicTimer: 0,
  logicSamples: 0,
  debugMode: false,       // Ctrl+D 切换
  hash: new Map(),
  bosses: [],
  mouseWorld: { x: 0, y: 0 }
};

const CB_HASH_CELL = 14;           // 略大于普通怪交互距离(2*6=12)，±1 邻域即可完整覆盖
const CB_HASH_OFF  = 2000;         // 负坐标偏移，避免哈希键碰撞
const CB_DMG_TEXT_CAP = 180;       // 飘字上限，防止高密度时爆量
const CB_EFFECT_CAP   = 60;
const CB_BULLET_SPEED = 900;       // px/s
const CB_REPEL_CAP    = 40;        // 单个怪物每帧最多计算的斥力对数

// BOSS 不入空间哈希，而是走独立小列表：
//   普通怪×普通怪 交互距离 12px → ±1 格(14px) 恰好覆盖，这是最常见的高性能路径
//   涉及 BOSS 的交互距离 46px → 远超 1 格，若为此扩大普通怪扫描范围，
//   会让全部小怪每帧多扫近 10 倍条目。
// 因此改为：哈希只索引普通怪，BOSS 单独存放，每只怪再额外遍历一次 BOSS 列表。
// BOSS 数量极少（个位数到几十），这次遍历开销可忽略。
const CB_BOSS_SCAN = 4;            // BOSS 自身扫描半径（格数），4×14=56px 覆盖 46px 交互距离

function cbHashKey(cx, cy) {
  return (cy + CB_HASH_OFF) * 100000 + (cx + CB_HASH_OFF);
}

// ---------- emoji 精灵预渲染 ----------
const CB_SPRITE_SS = 2;
const cbSprites = {};
function cbMakeSprite(emoji, radius) {
  const world = (radius + 3) * 2;
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(world * CB_SPRITE_SS);
  const g = c.getContext('2d');
  g.font = `${(radius * 2 * 0.92) * CB_SPRITE_SS}px "Segoe UI Emoji","Apple Color Emoji","Microsoft YaHei",sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji, c.width / 2, c.height / 2);
  return { canvas: c, world: world };
}
cbSprites.normal = cbMakeSprite('😗', MONSTER_RADIUS);
cbSprites.boss   = cbMakeSprite('👹', BOSS_RADIUS);

// ---------- 基础工具 ----------
function cbCellCenter(gx, gy) {
  return { x: gx * CELL_SIZE + CELL_SIZE / 2, y: gy * CELL_SIZE + CELL_SIZE / 2 };
}
function cbBaseCenter() {
  return cbCellCenter(state.base.x, state.base.y);
}
const CB_BASE_RADIUS = CELL_SIZE * 0.9;
const CB_TURRET_RADIUS = CELL_SIZE * 0.5;

// 火力发电站：建在煤矿上，每秒产出 10 点电量
const POWERPLANT_OUTPUT = 10;

// 每帧收集存活炮塔（建筑数远小于怪物数，开销可忽略）
// 同时建立 key -> 炮塔 的查找表，并给每座炮塔一个帧内稳定索引 idx，
// 供怪物寻路校验「目标是否仍存活」以及带头怪分组使用。
const cbTurrets = [];
function cbCollectTurrets() {
  cbTurrets.length = 0;
  cbTurretLookup.clear();
  state.gridData.forEach((data, key) => {
    const st = TURRET_STATS[data.type];
    if (!st) return;
    // 惰性初始化战斗字段（placeBuilding 不感知这些字段）
    if (data.hp === undefined) { data.hp = st.hp; data.maxHp = st.hp; data.cd = 0; }
    if (data.hp <= 0) return;
    const parts = key.split(',');
    const gx = +parts[0], gy = +parts[1];
    const tu = {
      idx: cbTurrets.length,
      key, gx, gy,
      x: gx * CELL_SIZE + CELL_SIZE / 2,
      y: gy * CELL_SIZE + CELL_SIZE / 2,
      data, stats: st
    };
    cbTurrets.push(tu);
    cbTurretLookup.set(key, tu);
  });
}

// 按格子 key 判断炮塔是否仍存活（走帧内查找表，避免每只怪重复遍历建筑表）
function cbTurretAlive(key) {
  const tu = cbTurretLookup.get(key);
  return tu !== undefined && tu.data.hp > 0;
}

// ---------- 空间哈希 ----------
// 桶数组走对象池：3000 只怪物若每帧新建数千个数组，GC 压力会吃掉大量帧时间
const cbBucketPool = [];
// 跨帧复用的查找表，避免每帧新建对象造成 GC 抖动
const cbTurretLookup = new Map();   // key -> 炮塔对象
const cbLeaderMap    = new Map();   // 目标标识 -> 距该目标最近的怪物索引（带头怪）
function cbBuildHash() {
  const h = combatState.hash;
  h.forEach((b) => { b.length = 0; cbBucketPool.push(b); });
  h.clear();
  const ms = combatState.monsters;
  const bosses = combatState.bosses;
  bosses.length = 0;
  // 哈希只索引普通怪；BOSS 走独立列表（数量极少，遍历开销可忽略）
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.hp <= 0) continue;
    if (m.isBoss) { bosses.push(i); continue; }
    const key = cbHashKey(Math.floor(m.x / CB_HASH_CELL), Math.floor(m.y / CB_HASH_CELL));
    let b = h.get(key);
    if (!b) {
      b = cbBucketPool.length > 0 ? cbBucketPool.pop() : [];
      h.set(key, b);
    }
    b.push(i);
  }
}

// 遍历 (x,y) 半径 r 附近可能相交的怪物（含 BOSS）；fn 返回 false 可提前终止
function cbForEachNearMonster(x, y, r, fn) {
  const h = combatState.hash;
  const ms = combatState.monsters;
  const cx0 = Math.floor((x - r) / CB_HASH_CELL), cx1 = Math.floor((x + r) / CB_HASH_CELL);
  const cy0 = Math.floor((y - r) / CB_HASH_CELL), cy1 = Math.floor((y + r) / CB_HASH_CELL);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const b = h.get(cbHashKey(cx, cy));
      if (!b) continue;
      for (let k = 0; k < b.length; k++) {
        const m = ms[b[k]];
        if (!m || m.hp <= 0) continue;
        if (fn(m) === false) return false;
      }
    }
  }
  // BOSS 不在哈希中，单独扫一遍（数量极少）
  const bosses = combatState.bosses;
  for (let k = 0; k < bosses.length; k++) {
    const m = ms[bosses[k]];
    if (!m || m.hp <= 0) continue;
    if (fn(m) === false) return false;
  }
  return true;
}

// ---------- 生成 ----------
// 指定方向的地图外生成点；dist 带随机抖动，避免怪物排成一条整齐的线。
// 铺开幅度按「半角」换算而非固定像素：垂直偏移 = tan(半角) × 径向距离，
// 这样无论径向距离抖到多大，最大偏角恒等于 CB_SPAWN_SPREAD_DEG，
// 既收窄了扇区，又不会因抖动而越到相邻方位、让预警提示失去意义。
function cbSpawnPos(dirIdx) {
  const dir = CB_DIRS[dirIdx | 0] || CB_DIRS[0];
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len, uy = dir.y / len;
  const px = -uy, py = ux;                          // 垂直方向，用于沿边铺开
  const dist = WORLD_PX * 0.75 + CB_SPAWN_MARGIN + Math.random() * CB_SPAWN_DEPTH;
  const halfSpread = Math.tan(CB_SPAWN_SPREAD_DEG * Math.PI / 180) * dist;
  const spread = (Math.random() * 2 - 1) * halfSpread;
  return {
    x: WORLD_PX / 2 + ux * dist + px * spread,
    y: WORLD_PX / 2 + uy * dist + py * spread
  };
}

// isBoss 时 hp 由调用方按「10000 + 波次×5000」传入
function cbAddMonster(x, y, isBoss, hpOverride) {
  const hp = isBoss ? hpOverride : cbMonsterHpFor(combatState.wave);
  combatState.monsters.push({
    x, y, vx: 0, vy: 0,
    radius: isBoss ? BOSS_RADIUS : MONSTER_RADIUS,
    hp, maxHp: hp,
    mass: isBoss ? BOSS_MASS : MONSTER_MASS,
    isBoss: !!isBoss,
    atkCd: 0,
    targetKey: null,       // 锁定的炮塔格子 key；null 表示目标为基地
    retargetTimer: 0,      // 寻路重判计时器：每 1s 重选一次目标
    gkey: null,            // 所属目标分组标识（= targetKey，null 为基地组）
    tx: 0, ty: 0, reach: 0,// 本帧缓存的目标坐标与可达距离
    hitFlash: 0
  });
  return true;
}

// 随机抽取本波来袭方向：数量 = ceil(波数/10)，不重复
function cbPickDirections(wave) {
  const n = cbWaveDirCount(wave);
  const pool = CB_DIRS.map((d, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {          // Fisher-Yates 部分洗牌
    const j = (Math.random() * (i + 1)) | 0;
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return pool.slice(0, n);
}

function cbDirLabel(dirs) {
  return dirs.map(i => CB_DIR_NAMES[i]).join('、');
}

// 一波怪物的总出怪时长（秒）= 9 + 波次
function cbWaveSpawnDuration(wave) {
  return CB_SPAWN_BASE_SEC + Math.max(1, wave);
}

// 每帧配额（可为小数）= 本波总数 / 总帧数（按 60fps 折算）。
// 小数部分由累加器进位处理：配额 1.5 时逐帧产出 1 或 2（不会超过 2），
// 既满足「1.01~1.99 这类小数进位到 2」，又让整波总数与总时长保持精确。
function cbWaveSpawnQuota(count, wave) {
  const frames = cbWaveSpawnDuration(wave) * 60;
  return count / Math.max(1, frames);
}

// 预警时预抽方向，使提示能报出具体方位；正式触发时沿用这批方向
function cbArmWaveWarning() {
  const nextWave = combatState.wave + 1;
  combatState.waveDirs = cbPickDirections(nextWave);
  combatState.waveWarned = true;
  const count = nextWave * gameConfig.waveCount;
  showToast(`⚠️ ${Math.round(WAVE_WARN_MS / 1000)} 秒后第 ${nextWave} 波来袭！${count} 只 · 来自 ${cbDirLabel(combatState.waveDirs)}（${combatState.waveDirs.length} 个方向）`);
}

function cbTriggerWave() {
  combatState.wave++;
  const wave = combatState.wave;
  const want = wave * gameConfig.waveCount;
  const dirs = combatState.waveDirs.length > 0 ? combatState.waveDirs : cbPickDirections(wave);
  combatState.waveDirs = dirs;
  combatState.waveWarned = false;

  // 队列按方向轮转排列：i % dirs.length
  // → 各方向数量自动平分（余数分给前几个方向），
  // → 出队时在各方向间交替，形成多股尸潮同时推进而非逐方向刷完
  const q = combatState.spawnQueue;
  for (let i = 0; i < want; i++) q.push(dirs[i % dirs.length]);
  combatState.spawnIdx = 0;
  combatState.spawnCredit = 0;
  combatState.spawnQuota = cbWaveSpawnQuota(want, wave);

  // 每第 10 波追加一只 BOSS，等本波小怪全部出完后再刷
  if (wave % 10 === 0) {
    combatState.pendingBoss++;
    // 从本波实际用到的进场方向里随机挑一个
    combatState.bossSpawnDir = dirs[(Math.random() * dirs.length) | 0];
  }

  showToast(`⚔️ 第 ${wave} 波开始！${want} 只 · ${cbWaveSpawnDuration(wave)} 秒内涌入 · ${cbDirLabel(dirs)}（${dirs.length} 个方向）`);
}

// 每帧按配额累加生成：配额可为小数，整数部分当帧生成，小数部分留存到后续帧，
// 因此「每帧 1.01~1.99 只」表现为逐帧产出 1 或 2 只（向上取整），
// 而整波总数与总时长依然精确对齐 (9+波次) 秒。
// 帧率低于阈值时暂停生成（队列与配额原样保留），恢复后自动续刷。
// 小怪全部出完后才刷新本波 BOSS（每第 10 波一只）。
function cbDrainSpawnQueue(dt) {
  const q = combatState.spawnQueue;
  if (combatState.gameOver) return;

  // --- BOSS 刷新：等本波小怪出完 ---
  if (combatState.spawnIdx >= q.length) {
    if (combatState.pendingBoss > 0 && combatState.spawnAllowed) {
      combatState.pendingBoss--;
      const dirIdx = combatState.bossSpawnDir === null ? 0 : combatState.bossSpawnDir;
      const p = cbSpawnPos(dirIdx);
      const hp = cbBossHpFor(combatState.wave);
      cbAddMonster(p.x, p.y, true, hp);
      showToast(`👹 BOSS 出现！血量 ${hp.toLocaleString()} · 来自 ${CB_DIR_NAMES[dirIdx]}`);
    }
    return;
  }

  // 帧率不足则暂停生成（队列原样保留），恢复后自动续刷
  if (!combatState.spawnAllowed) return;

  // dt 归一到 60fps 基准帧：掉帧时单帧配额相应放大，
  // 保证「总时长 = (9+波次) 秒」不受实际帧率影响。
  combatState.spawnCredit += combatState.spawnQuota * (dt / CB_SPAWN_FRAME_MS);

  let n = Math.floor(combatState.spawnCredit);
  if (n <= 0) return;
  combatState.spawnCredit -= n;

  let guard = 0;
  while (n > 0 && combatState.spawnIdx < q.length) {
    if (!combatState.spawnAllowed) return;                 // 泄流途中掉帧也要立即停
    const dirIdx = q[combatState.spawnIdx];
    const p = cbSpawnPos(dirIdx);
    combatState.spawnIdx++;
    cbAddMonster(p.x, p.y, false);
    n--;
    if (++guard > 600) {                                   // 单帧生成量上界，防卡顿
      combatState.spawnCredit += n;                        // 未生成完的退回配额
      break;
    }
  }
}

// 帧率门控：每秒统计一次实际 FPS，< 60 停止生成，>= 60 恢复生成
// 注意浮点陷阱：rAF 的 dt 常为 16.6667，累加 60 次得 999.9999…，
// 直接判 fps >= 60 会因 1e-5 量级误差把「真 60fps」误判为不足，
// 导致 spawnAllowed 永远为 false、怪物完全不生成。故判定必须带容差。
const CB_FPS_EPS = 0.5;            // 容差：59.9998 视为达标，真实 50fps 仍会被挡下
function cbUpdateFpsGate(dt) {
  combatState.fpsTimer += dt;
  combatState.frameSamples++;
  // 窗口略放宽，避免浮点误差把判定推迟一整帧
  if (combatState.fpsTimer < CB_FPS_CHECK_MS - 1) return;

  const fps = combatState.frameSamples * 1000 / combatState.fpsTimer;
  combatState.fps = fps;
  combatState.frameSamples = 0;
  combatState.fpsTimer = 0;

  const allow = fps >= CB_FPS_TARGET - CB_FPS_EPS;
  if (allow !== combatState.spawnAllowed) {
    combatState.spawnAllowed = allow;
    if (!allow) showToast(`⚠️ 帧率 ${fps.toFixed(1)} < ${CB_FPS_TARGET}，暂停刷怪`);
  }
}

// 由渲染循环每帧回传「三段逻辑更新」的实测耗时(ms)，取 10 帧滑动平均
function cbSampleLogic(ms) {
  combatState.logicTimer += ms;
  combatState.logicSamples++;
  if (combatState.logicSamples < 10) return;
  combatState.logicMs = combatState.logicTimer / combatState.logicSamples;
  combatState.logicTimer = 0;
  combatState.logicSamples = 0;
}

// ---------- 基地等级系统 ----------
const BASE_MAX_LEVEL   = 5;
const BASE_UP_COST_K   = 1000;     // 升级消耗 = 1000 × 当前等级²
const BASE_RADIUS_STEP = 10;       // 每级半径 +10
const BASE_POWER_CAP1  = 1000;     // 1 级电量上限，之后每级翻倍

// 升到下一级所需金属（1→2 为 1000，2→3 为 4000，3→4 为 9000，4→5 为 16000）
// 已满级返回 null
function cbBaseUpgradeCost() {
  if (combatState.baseLevel >= BASE_MAX_LEVEL) return null;
  return BASE_UP_COST_K * combatState.baseLevel * combatState.baseLevel;
}

// 当前等级的电量上限：1000 / 2000 / 4000 / 8000 / 16000
function cbBasePowerCap() {
  return BASE_POWER_CAP1 * Math.pow(2, combatState.baseLevel - 1);
}

// 电量入池：由火力发电站等每秒调用，超上限部分丢弃
function cbAddPower(amount) {
  const cap = cbBasePowerCap();
  if (combatState.basePower >= cap) return 0;
  const before = combatState.basePower;
  combatState.basePower = Math.min(cap, combatState.basePower + amount);
  return combatState.basePower - before;
}

// 耗电：够则扣除返回 true，不够返回 false（调用方自行决定是否跳过动作）
function cbSpendPower(amount) {
  if (amount <= 0) return true;
  if (combatState.basePower < amount) return false;
  combatState.basePower -= amount;
  return true;
}

function cbTryUpgradeBase() {
  const cost = cbBaseUpgradeCost();
  if (cost === null) { showToast('基地已达最高等级 (5 级)'); return false; }
  if (globalState.metal < cost) { showToast(`金属不足！升级需要 ${cost} (当前 ${globalState.metal})`); return false; }

  globalState.metal -= cost;
  combatState.baseLevel++;
  // 写回半径：game.js 的建造校验、范围高亮、矿脉生成均读取该值，自动同步扩大
  state.base.radius = 10 + (combatState.baseLevel - 1) * BASE_RADIUS_STEP;
  state.needsRedraw = true;
  updateGlobalUI();
  cbSyncBaseLevel();

  cbAddEffect(cbBaseCenter().x, cbBaseCenter().y, 120, '#64c8ff');
  showToast(`⬆️ 基地升至 ${combatState.baseLevel} 级！控制半径 ${state.base.radius} 格 · 电量上限 ${cbBasePowerCap()}`);
  return true;
}

function cbSyncBaseLevel() {
  if (!cbHud.lvlVal) {
    cbHud.lvlVal = document.getElementById('base-level-val');
    cbHud.lvlRadius = document.getElementById('base-level-radius');
    cbHud.lvlCost = document.getElementById('base-level-cost');
    cbHud.lvlHp = document.getElementById('base-level-hp');
    cbHud.lvlPower = document.getElementById('base-level-power');
    cbHud.baseSection = document.getElementById('base-section');
    cbHud.lvlBtn = document.getElementById('btn-base-upgrade');
    if (cbHud.lvlBtn) cbHud.lvlBtn.addEventListener('click', (e) => { e.stopPropagation(); cbTryUpgradeBase(); });
  }
  const cost = cbBaseUpgradeCost();
  if (cbHud.lvlVal) cbHud.lvlVal.textContent = `Lv.${combatState.baseLevel}`;
  if (cbHud.lvlRadius) cbHud.lvlRadius.textContent = `控制半径 ${state.base.radius} 格`;
  if (cbHud.lvlHp) cbHud.lvlHp.textContent = `${Math.max(0, Math.ceil(combatState.baseHp))} / ${CB_BASE_MAX_HP}`;
  if (cbHud.lvlPower) {
    cbHud.lvlPower.textContent = `${Math.floor(combatState.basePower)} / ${cbBasePowerCap()} ⚡`;
  }
  if (cbHud.lvlCost) {
    cbHud.lvlCost.textContent = cost === null ? '已达最高等级' : `升级费用 ${cost} 🟡 (1000×${combatState.baseLevel}²)`;
  }
  if (cbHud.lvlBtn) {
    if (cost === null) {
      cbHud.lvlBtn.disabled = true;
      cbHud.lvlBtn.textContent = '已达最高等级 (5 级)';
    } else {
      cbHud.lvlBtn.disabled = globalState.metal < cost;
      cbHud.lvlBtn.textContent = `升级到 ${combatState.baseLevel + 1} 级 (${cost} 🟡)`;
    }
  }
}

// 打开基地等级面板（点击基地时调用）
function cbShowBasePanel() {
  cbSyncBaseLevel();
  if (cbHud.baseSection) cbHud.baseSection.style.display = 'block';
  const ts = document.getElementById('turret-section');
  if (ts) ts.style.display = 'none';
  const ss = document.getElementById('storage-section');
  if (ss) ss.style.display = 'none';
  const fs = document.getElementById('furnace-section');
  if (fs) fs.style.display = 'none';
  const title = document.getElementById('panel-title');
  if (title) title.textContent = '基地指挥';
  const typeEl = document.getElementById('info-type');
  if (typeEl) typeEl.textContent = '指挥中心';
  const coordEl = document.getElementById('info-coords');
  if (coordEl) coordEl.textContent = `${state.base.x}, ${state.base.y}`;
  const descEl = document.getElementById('info-desc');
  if (descEl) descEl.textContent = '基地被摧毁即游戏结束。升级费用 = 1000×当前等级²，每级控制半径 +10 格、电量上限翻倍（1000 起步），最高 5 级。基地与炮塔每秒各恢复 1 点耐久。';
  const dem = document.getElementById('btn-demolish');
  if (dem) dem.style.display = 'none';
  uiPanel.classList.add('visible');
}

// 关闭基地等级面板（选中其他建筑或关闭 UI 时调用）
function cbHideBasePanel() {
  if (cbHud.baseSection) cbHud.baseSection.style.display = 'none';
  const dem = document.getElementById('btn-demolish');
  if (dem) dem.style.display = '';
}

// ---------- 主更新 ----------
function updateCombat(dt) {
  if (dt > 100) dt = 100;            // 切后台回来的巨大 dt 保护
  if (!combatState.running) combatState.running = true;
  combatState.time += dt;
  state.needsRedraw = true;          // 怪物/弹道持续运动，需每帧重绘

  cbCollectTurrets();
  cbUpdateFpsGate(dt);
  cbUpdateWaveTimer(dt);
  cbDrainSpawnQueue(dt);
  cbRegen(dt);
  cbUpdatePower(dt);

  if (!combatState.gameOver) {
    cbUpdateMonsters(dt);
    cbUpdateTurrets(dt);
  }
  cbUpdateBullets(dt);
  cbUpdateShells(dt);
  cbUpdateBeams(dt);
  cbUpdateEffects(dt);
  cbUpdateDmgTexts(dt);
  cbSyncHUD();

  if (!combatState.gameOver && combatState.baseHp <= 0) {
    combatState.gameOver = true;
    combatState.baseHp = 0;
    showToast('💀 基地已被摧毁');
  }
}

function cbUpdateWaveTimer(dt) {
  if (combatState.gameOver) return;
  combatState.elapsed += dt;
  combatState.waveTimer -= dt;

  // 到来前 30s 预警一次，并报出具体来袭方位
  if (!combatState.waveWarned && combatState.waveTimer <= WAVE_WARN_MS) cbArmWaveWarning();

  if (combatState.waveTimer <= 0) {
    combatState.waveTimer += WAVE_INTERVAL;
    cbTriggerWave();
  }
}

// 每秒结算：火力发电站每座产出 10 点电量，汇入基地电量池
function cbUpdatePower(dt) {
  combatState.powerTimer += dt;
  if (combatState.powerTimer < 1000) return;
  combatState.powerTimer -= 1000;

  let produced = 0;
  state.gridData.forEach((data) => {
    if (data.type === 'powerplant') produced += POWERPLANT_OUTPUT;
  });
  if (produced > 0) {
    cbAddPower(produced);
    state.needsRedraw = true;
  }
}

// 每秒恢复生命：基地与炮塔各 +1
function cbRegen(dt) {
  if (combatState.gameOver) return;
  combatState.regenTimer += dt;
  if (combatState.regenTimer < 1000) return;
  combatState.regenTimer -= 1000;

  if (combatState.baseHp > 0 && combatState.baseHp < CB_BASE_MAX_HP) {
    combatState.baseHp = Math.min(CB_BASE_MAX_HP, combatState.baseHp + 1);
  }
  for (let t = 0; t < cbTurrets.length; t++) {
    const tu = cbTurrets[t];
    if (tu.data.hp > 0 && tu.data.hp < tu.data.maxHp) {
      tu.data.hp = Math.min(tu.data.maxHp, tu.data.hp + 1);
      state.needsRedraw = true;
    }
  }
}

function cbUpdateMonsters(dt) {
  const F = dt / 16.6667;            // 以 60fps 归一化（规格数值按帧给出）
  const damp = Math.pow(MONSTER_DAMP, F);
  const ms = combatState.monsters;
  const base = cbBaseCenter();
  const anyTurret = cbTurrets.length > 0;

  cbBuildHash();                     // 数组在本阶段不变更，索引始终有效

  // ===== 第一趟：选目标 + 选举带头怪 =====
  // 寻路规则：默认直奔基地；若 6 格(192px)半径内有炮塔，改为冲向最近的那座。
  // 重判时机：每 CB_RETARGET_MS(1s) 一次，或锁定的炮塔被摧毁时立即重判。
  // 带头怪：同一目标分组内「距目标最近」者带头，其余怪物跟随带头怪移动。
  cbLeaderMap.clear();
  const seek2 = CB_TURRET_SEEK_PX * CB_TURRET_SEEK_PX;
  let killed = 0;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.hp <= 0) { killed++; continue; }

    m.retargetTimer -= dt;
    const targetGone = m.targetKey !== null && !cbTurretAlive(m.targetKey);
    if (m.retargetTimer <= 0 || targetGone) {
      m.retargetTimer = CB_RETARGET_MS;
      m.targetKey = null;
      if (anyTurret) {
        let bestD2 = seek2, bestTu = null;      // 只在 6 格内找，找不到就继续奔基地
        for (let t = 0; t < cbTurrets.length; t++) {
          const tu = cbTurrets[t];
          if (tu.data.hp <= 0) continue;
          const dx = tu.x - m.x, dy = tu.y - m.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; bestTu = tu; }
        }
        if (bestTu) m.targetKey = bestTu.key;
      }
    }

    // 缓存本帧的目标坐标与可达距离（炮塔可能在本帧内被摧毁 → 立即回退基地）
    let gkey = m.targetKey;
    if (gkey !== null) {
      const tu = cbTurretLookup.get(gkey);
      if (tu && tu.data.hp > 0) {
        m.tx = tu.x; m.ty = tu.y; m.reach = m.radius + CB_TURRET_RADIUS;
      } else {
        gkey = null; m.targetKey = null;
      }
    }
    if (gkey === null) {
      m.tx = base.x; m.ty = base.y; m.reach = m.radius + CB_BASE_RADIUS;
    }
    m.gkey = gkey;

    // 带头怪选举：记录该分组内距目标最近的怪物索引
    const gx = m.tx - m.x, gy = m.ty - m.y;
    const gd2 = gx * gx + gy * gy;
    const prev = cbLeaderMap.get(gkey);
    if (prev === undefined || gd2 < prev.d2) cbLeaderMap.set(gkey, { i, d2: gd2 });
  }

  // ===== 第二趟：受力积分（斥力 + 引力/跟随 + 攻击）=====
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];

    // 物理阶段绝不变更数组：哈希索引在整个循环中必须保持有效，
    // 死亡个体只在末尾统一压缩。
    if (m.hp <= 0) continue;

    if (m.hitFlash > 0) m.hitFlash -= dt;

    let ax = 0, ay = 0;

    // 带头怪冲向目标；其余怪物跟着带头怪走，自然拉出尸潮队形
    const lead = cbLeaderMap.get(m.gkey);
    let sx, sy, reach;
    if (lead !== undefined && lead.i !== i) {
      const L = ms[lead.i];
      sx = L.x; sy = L.y;
      reach = m.radius + L.radius;              // 贴到带头怪即停，靠斥力散开成团
    } else {
      sx = m.tx; sy = m.ty; reach = m.reach;
    }

    const dx = sx - m.x, dy = sy - m.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > reach) {
      // --- 引力：恒定强度，方向指向移动目标 ---
      ax += (dx / dist) * MONSTER_ATTRACT;
      ay += (dy / dist) * MONSTER_ATTRACT;
    }

    // --- 攻击：只有真正贴到自己的「攻击目标」时才出手（跟随者贴着带头怪不算）---
    const adx = m.tx - m.x, ady = m.ty - m.y;
    if (adx * adx + ady * ady <= m.reach * m.reach) {
      m.atkCd -= dt;
      if (m.atkCd <= 0) {
        m.atkCd += MONSTER_ATK_CD;
        if (m.targetKey) {
          const tu = cbTurretLookup.get(m.targetKey);
          if (tu && tu.data.hp > 0) {
            tu.data.hp -= MONSTER_DAMAGE;
            cbAddDmgText(m.tx, m.ty - 20, MONSTER_DAMAGE, '#ff6b6b');
            if (tu.data.hp <= 0) { tu.data.hp = 0; cbDestroyTurret(m.tx, m.ty, tu.data); }
          }
        } else if (!combatState.gameOver) {
          combatState.baseHp -= MONSTER_DAMAGE;
          cbAddDmgText(base.x, base.y - 24, MONSTER_DAMAGE, '#ff6b6b');
        }
      }
    }

    // --- 粒子间斥力（距离 < 2*radius 时生效）---
    // 普通怪：哈希 ±1 格即覆盖 12px 交互距离（格边长 14），这是最常见的高性能路径
    // BOSS  ：±4 格覆盖 46px 交互距离；BOSS 数量极少，宽扫描开销可忽略
    // 键用「基址 + 行列偏移」增量计算，避免每格重复 floor 与乘法
    const cx = Math.floor(m.x / CB_HASH_CELL), cy = Math.floor(m.y / CB_HASH_CELL);
    const sr = m.isBoss ? CB_BOSS_SCAN : 1;
    const baseKey = (cy + CB_HASH_OFF) * 100000 + (cx + CB_HASH_OFF);
    let repX = 0, repY = 0, checked = 0;
    outer:
    for (let oy = -sr; oy <= sr; oy++) {
      const rowKey = baseKey + oy * 100000;
      for (let ox = -sr; ox <= sr; ox++) {
        const b = combatState.hash.get(rowKey + ox);
        if (!b) continue;
        for (let k = 0; k < b.length; k++) {
          const j = b[k];
          if (j === i) continue;
          const o = ms[j];
          if (!o || o.hp <= 0) continue;
          const ddx = m.x - o.x, ddy = m.y - o.y;
          const minD = m.radius + o.radius;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 >= minD * minD || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const f = MONSTER_REPEL * (1 - d / minD);
          repX += (ddx / d) * f;
          repY += (ddy / d) * f;
          if (++checked >= CB_REPEL_CAP) break outer;
        }
      }
    }
    // 与 BOSS 的相互排斥（BOSS 不在哈希中，单独线性遍历）
    const bosses = combatState.bosses;
    for (let k = 0; k < bosses.length && checked < CB_REPEL_CAP; k++) {
      const j = bosses[k];
      if (j === i) continue;
      const o = ms[j];
      if (!o || o.hp <= 0) continue;
      const ddx = m.x - o.x, ddy = m.y - o.y;
      const minD = m.radius + o.radius;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 >= minD * minD || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const f = MONSTER_REPEL * (1 - d / minD);
      repX += (ddx / d) * f;
      repY += (ddy / d) * f;
      checked++;
    }
    ax += repX; ay += repY;

    // --- 积分（质量越大越迟钝，BOSS 可碾压推进）---
    const inv = 1 / m.mass;
    m.vx = (m.vx + ax * inv * F) * damp;
    m.vy = (m.vy + ay * inv * F) * damp;
    m.x += m.vx * F;
    m.y += m.vy * F;
  }
  // 物理阶段结束后统一压缩，此时数组索引已不再被哈希引用
  if (killed > 0) {
    let w = 0;
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].hp > 0) ms[w++] = ms[i];
    }
    ms.length = w;
    combatState.kills += killed;
    cbBuildHash();                 // 重建，供本帧弹道碰撞使用
  }
}

function cbDestroyTurret(x, y, data) {
  const st = TURRET_STATS[data.type];
  const gx = Math.floor(x / CELL_SIZE), gy = Math.floor(y / CELL_SIZE);
  const key = `${gx},${gy}`;
  state.gridData.delete(key);
  if (state.selectedCell && state.selectedCell.x === gx && state.selectedCell.y === gy) closeUI();
  cbAddEffect(x, y, 70, '#ff8844');
  showToast(`💥 ${st ? st.name : '炮塔'} 被摧毁！怪物转向基地`);
  state.needsRedraw = true;
}

// ---------- 炮塔索敌 + 开火 ----------
// powerWarnTimer：狙击塔缺电提示的节流计时，避免每帧弹 toast
let cbPowerWarnTimer = 0;

function cbUpdateTurrets(dt) {
  const ms = combatState.monsters;
  if (cbPowerWarnTimer > 0) cbPowerWarnTimer -= dt;
  if (ms.length === 0) return;

  for (let t = 0; t < cbTurrets.length; t++) {
    const tu = cbTurrets[t];
    tu.data.cd -= dt;
    if (tu.data.cd > 0) continue;

    const st = tu.stats;
    const min2 = st.minRange * st.minRange;
    const max2 = st.maxRange * st.maxRange;
    let best = null, bestD = Infinity;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.hp <= 0) continue;
      const dx = m.x - tu.x, dy = m.y - tu.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < min2 || d2 > max2) continue;
      if (d2 < bestD) { bestD = d2; best = m; }
    }
    if (!best) continue;

    // --- 电磁狙击塔：锁定即命中，无弹道；每次开火耗电 ---
    if (st.projectile === 'hitscan') {
      // 电量不足则不开火（cd 不重置，来电后自动恢复射击），提示做节流
      if (!cbSpendPower(st.powerCost)) {
        if (cbPowerWarnTimer <= 0) {
          cbPowerWarnTimer = 2000;
          showToast(`⚡ 电量不足，${st.name}无法开火（每次需 ${st.powerCost}）`);
        }
        tu.data.cd = 0;                 // 保持待击发状态，电量恢复即开火
        continue;
      }
      tu.data.cd = st.fireInterval;
      best.hp -= st.damage;
      best.hitFlash = 120;
      cbAddDmgText(best.x, best.y - best.radius - 6, st.damage, '#4de3ff');
      cbAddBeam(tu.x, tu.y, best.x, best.y, st.color);
      continue;
    }

    tu.data.cd = st.fireInterval;
    if (st.projectile === 'bullet') {
      const d = Math.sqrt(bestD) || 1;
      combatState.bullets.push({
        x: tu.x, y: tu.y, px: tu.x, py: tu.y,
        vx: ((best.x - tu.x) / d) * CB_BULLET_SPEED,
        vy: ((best.y - tu.y) / d) * CB_BULLET_SPEED,
        dmg: st.damage, color: st.color,
        // 飞出本炮塔最大射程即消失，使「射程」对子弹同样生效
        life: (st.maxRange / CB_BULLET_SPEED) * 1000
      });
    } else {
      // 炮弹：锁定目标当前位置为落点，走抛物线
      const d = Math.sqrt(bestD) || 1;
      combatState.shells.push({
        sx: tu.x, sy: tu.y, tx: best.x, ty: best.y,
        p: 0, dur: Math.max(280, (d / 520) * 1000),
        arc: Math.min(160, 40 + d * 0.12),
        dmg: st.damage, blast: st.blastRadius, color: st.color
      });
    }
  }
}

// ---------- 弹道 ----------
// 子弹速度 900px/s（60fps 下每帧约 15px）远大于小怪判定半径（6+3=9px），
// 逐帧点检测会「穿透」小怪，因此改用线段-圆扫掠检测。
function cbUpdateBullets(dt) {
  const bs = combatState.bullets;
  const s = dt / 1000;
  const pad = 400;
  for (let i = bs.length - 1; i >= 0; i--) {
    const b = bs[i];
    b.px = b.x; b.py = b.y;                 // 记录上一帧位置，构成扫掠线段
    b.x += b.vx * s;
    b.y += b.vy * s;
    b.life -= dt;
    if (b.life <= 0 || b.x < -pad || b.y < -pad || b.x > WORLD_PX + pad || b.y > WORLD_PX + pad) {
      bs.splice(i, 1); continue;
    }
    // 命中检测：以扫掠线段中点为圆心做一次哈希查询（线段长约 15px，
    // 半径取 24 可完整覆盖「圆与线段距离 ≤ 9」的所有候选），再做精确线段-圆判定
    let hit = false;
    cbForEachNearMonster((b.px + b.x) * 0.5, (b.py + b.y) * 0.5, 24, (m) => {
      if (cbSegHitsCircle(b.px, b.py, b.x, b.y, m.x, m.y, m.radius + 3)) {
        m.hp -= b.dmg;
        m.hitFlash = 90;
        cbAddDmgText(m.x, m.y - m.radius - 4, b.dmg, '#d9b3ff');
        hit = true;
        return false;                                  // 命中后停止遍历
      }
    });
    if (hit) bs.splice(i, 1);
  }
}

// 线段 (x1,y1)-(x2,y2) 是否与圆心 (cx,cy) 半径 r 的圆相交
function cbSegHitsCircle(x1, y1, x2, y2, cx, cy, r) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = cx - x1, wy = cy - y1;
  const vv = vx * vx + vy * vy;
  let t = vv > 0 ? (wx * vx + wy * vy) / vv : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const dx = x1 + vx * t - cx, dy = y1 + vy * t - cy;
  return dx * dx + dy * dy <= r * r;
}

function cbUpdateShells(dt) {
  const sh = combatState.shells;
  for (let i = sh.length - 1; i >= 0; i--) {
    const p = sh[i];
    p.p += dt / p.dur;
    if (p.p < 1) continue;
    sh.splice(i, 1);

    cbAddEffect(p.tx, p.ty, p.blast, p.color);
    // 落点范围爆炸（炮弹数量少，直接全量扫描）
    const ms = combatState.monsters;
    const r2 = p.blast * p.blast;
    for (let j = 0; j < ms.length; j++) {
      const m = ms[j];
      if (m.hp <= 0) continue;
      const dx = m.x - p.tx, dy = m.y - p.ty;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const falloff = 1 - 0.5 * (Math.sqrt(d2) / p.blast);   // 中心满伤，边缘半伤
      const dmg = Math.max(1, Math.round(p.dmg * falloff));
      m.hp -= dmg;
      m.hitFlash = 90;
      cbAddDmgText(m.x, m.y - m.radius - 4, dmg, '#9ecbff');
    }
  }
}

function cbAddEffect(x, y, r, color) {
  if (combatState.effects.length >= CB_EFFECT_CAP) combatState.effects.shift();
  combatState.effects.push({ x, y, r: 4, maxR: r, life: 320, maxLife: 320, color });
}

// 狙击塔「锁定即命中」的视觉反馈：只闪烁 90ms，没有飞行过程，
// 不属于弹道，仅用于让玩家看出这一枪打在哪。
function cbAddBeam(x1, y1, x2, y2, color) {
  if (combatState.beams.length >= CB_EFFECT_CAP) combatState.beams.shift();
  combatState.beams.push({ x1, y1, x2, y2, color, life: 90, maxLife: 90 });
}
function cbUpdateBeams(dt) {
  const bs = combatState.beams;
  for (let i = bs.length - 1; i >= 0; i--) {
    bs[i].life -= dt;
    if (bs[i].life <= 0) bs.splice(i, 1);
  }
}
function cbUpdateEffects(dt) {
  const es = combatState.effects;
  for (let i = es.length - 1; i >= 0; i--) {
    const e = es[i];
    e.life -= dt;
    if (e.life <= 0) { es.splice(i, 1); continue; }
    e.r = e.maxR * (1 - e.life / e.maxLife);
  }
}

function cbAddDmgText(x, y, val, color) {
  if (combatState.dmgTexts.length >= CB_DMG_TEXT_CAP) return;
  combatState.dmgTexts.push({ x, y, val, color, life: 700, maxLife: 700 });
}
function cbUpdateDmgTexts(dt) {
  const ds = combatState.dmgTexts;
  for (let i = ds.length - 1; i >= 0; i--) {
    const d = ds[i];
    d.life -= dt;
    if (d.life <= 0) { ds.splice(i, 1); continue; }
    d.y -= dt * 0.03;
  }
}

// ---------- 绘制（世界空间） ----------
function cbVisibleWorldRect() {
  return {
    x0: (0 - state.panX) / state.scale - 60,
    y0: (0 - state.panY) / state.scale - 60,
    x1: (canvas.width - state.panX) / state.scale + 60,
    y1: (canvas.height - state.panY) / state.scale + 60
  };
}

function drawCombat() {
  const vr = cbVisibleWorldRect();
  cbDrawRangeRings();
  cbDrawMonsters(vr);
  cbDrawShells();
  cbDrawBullets();
  cbDrawBeams();
  cbDrawEffects();
  cbDrawTurretHpBars(vr);
  cbDrawMonsterHpBars(vr);
  cbDrawDmgTexts(vr);
}

function cbDrawRangeRings() {
  const breathe = 0.5 + 0.5 * Math.sin(combatState.time / 420);
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.lineDashOffset = -combatState.time / 60;
  for (let t = 0; t < cbTurrets.length; t++) {
    const tu = cbTurrets[t];
    const focus = state.selectedCell &&
      state.selectedCell.x === tu.gx && state.selectedCell.y === tu.gy;
    // 外圈 = 最大射程（青色）
    ctx.strokeStyle = focus ? 'rgba(100,255,255,0.85)' : `rgba(100,255,255,${(0.14 + 0.1 * breathe).toFixed(3)})`;
    ctx.lineWidth = focus ? 2 : 1;
    ctx.beginPath();
    ctx.arc(tu.x, tu.y, tu.stats.maxRange * (1 + 0.012 * breathe), 0, Math.PI * 2);
    ctx.stroke();
    // 内圈 = 最小射程（红色）
    ctx.strokeStyle = focus ? 'rgba(255,90,90,0.9)' : `rgba(255,90,90,${(0.14 + 0.1 * breathe).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(tu.x, tu.y, tu.stats.minRange * (1 - 0.03 * breathe), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // 建造预览：当前工具为炮塔时，在悬停格显示射程圈
  if (state.currentTool && TURRET_STATS[state.currentTool] && state.hoverCell) {
    const c = cbCellCenter(state.hoverCell.x, state.hoverCell.y);
    const st = TURRET_STATS[state.currentTool];
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(100,255,255,0.55)';
    ctx.beginPath(); ctx.arc(c.x, c.y, st.maxRange, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,90,90,0.55)';
    ctx.beginPath(); ctx.arc(c.x, c.y, st.minRange, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

function cbDrawMonsters(vr) {
  const ms = combatState.monsters;
  if (ms.length === 0) return;
  ctx.save();
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    // 死亡个体在物理阶段末尾才统一压缩，这里跳过避免尸体多渲染一帧
    if (m.hp <= 0) continue;
    if (m.x < vr.x0 || m.y < vr.y0 || m.x > vr.x1 || m.y > vr.y1) continue;
    const sp = m.isBoss ? cbSprites.boss : cbSprites.normal;
    const half = sp.world / 2;
    ctx.drawImage(sp.canvas, m.x - half, m.y - half, sp.world, sp.world);
    if (m.hitFlash > 0) {
      ctx.globalAlpha = Math.min(0.55, m.hitFlash / 90 * 0.55);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

function cbDrawBullets() {
  const bs = combatState.bullets;
  if (bs.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 3;
  const tl = 16;                                   // 尾迹长度
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    const sp = Math.hypot(b.vx, b.vy) || 1;
    ctx.strokeStyle = b.color;
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(b.x - (b.vx / sp) * tl, b.y - (b.vy / sp) * tl);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function cbDrawShells() {
  const sh = combatState.shells;
  if (sh.length === 0) return;
  ctx.save();
  for (let i = 0; i < sh.length; i++) {
    const p = sh[i];
    const gx = p.sx + (p.tx - p.sx) * p.p;
    const gy = p.sy + (p.ty - p.sy) * p.p;
    const h = Math.sin(p.p * Math.PI) * p.arc;
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';            // 地面阴影投影
    ctx.beginPath();
    ctx.ellipse(gx, gy, 6, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(gx, gy - h, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function cbDrawEffects() {
  const es = combatState.effects;
  if (es.length === 0) return;
  ctx.save();
  ctx.shadowBlur = 0;
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    const a = Math.max(0, e.life / e.maxLife);
    ctx.globalAlpha = a * 0.18;
    ctx.fillStyle = e.color;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = a * 0.9;
    ctx.strokeStyle = e.color;
    ctx.lineWidth = 3 * a + 1;
    ctx.stroke();
  }
  ctx.restore();
}

function cbDrawBeams() {
  const bs = combatState.beams;
  if (bs.length === 0) return;
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.lineCap = 'round';
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    const a = Math.max(0, b.life / b.maxLife);
    ctx.globalAlpha = a * 0.9;
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2 + a * 3;
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();
  }
  ctx.restore();
}

function cbDrawTurretHpBars(vr) {
  ctx.save();
  ctx.shadowBlur = 0;
  for (let t = 0; t < cbTurrets.length; t++) {
    const tu = cbTurrets[t];
    if (tu.x < vr.x0 || tu.y < vr.y0 || tu.x > vr.x1 || tu.y > vr.y1) continue;
    const ratio = Math.max(0, tu.data.hp / tu.data.maxHp);
    if (ratio >= 1) continue;                      // 满血不画，减少视觉噪音
    const w = 28, h = 4;
    const x = tu.x - w / 2, y = tu.y - CELL_SIZE * 0.5 - 9;
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = ratio > 0.5 ? '#5ddc6a' : ratio > 0.25 ? '#ffcc44' : '#ff5544';
    ctx.fillRect(x, y, w * ratio, h);
  }
  ctx.restore();
}

function cbDrawMonsterHpBars(vr) {
  // 仅 BOSS 显示头顶血条：普通怪可达 3000 只，逐个画血条会拖垮帧率
  const ms = combatState.monsters;
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.font = '10px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (!m.isBoss) continue;
    if (m.x < vr.x0 || m.y < vr.y0 || m.x > vr.x1 || m.y > vr.y1) continue;
    const ratio = Math.max(0, m.hp / m.maxHp);
    const w = 64, h = 6;
    const x = m.x - w / 2, y = m.y - m.radius - 16;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = '#ff4d4d';
    ctx.fillRect(x, y, w * ratio, h);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${Math.max(0, Math.ceil(m.hp))} / ${m.maxHp}`, m.x, y - 3);
  }
  ctx.restore();
}

function cbDrawDmgTexts(vr) {
  const ds = combatState.dmgTexts;
  if (ds.length === 0) return;
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 13px "Microsoft YaHei",sans-serif';
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    if (d.x < vr.x0 || d.y < vr.y0 || d.x > vr.x1 || d.y > vr.y1) continue;
    ctx.globalAlpha = Math.max(0, d.life / d.maxLife);
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(d.val, d.x + 1, d.y + 1);
    ctx.fillStyle = d.color;
    ctx.fillText(d.val, d.x, d.y);
  }
  ctx.restore();
}

// ---------- DOM HUD ----------
const cbHud = { ready: false };

// 供 game.js 的 selectBuilding / updatePanelContent 调用
function cbSyncTurretPanel(data) {
  if (!cbHud.turretSection) {
    cbHud.turretSection = document.getElementById('turret-section');
    cbHud.tHp = document.getElementById('info-turret-hp');
    cbHud.tHpFill = document.getElementById('info-turret-hp-fill');
    cbHud.tDmg = document.getElementById('info-turret-dmg');
    cbHud.tRate = document.getElementById('info-turret-rate');
    cbHud.tRange = document.getElementById('info-turret-range');
  }
  const st = data && TURRET_STATS[data.type];
  if (!st) {
    if (cbHud.turretSection) cbHud.turretSection.style.display = 'none';
    return;
  }
  if (data.hp === undefined) { data.hp = st.hp; data.maxHp = st.hp; data.cd = 0; }

  cbHud.turretSection.style.display = 'block';
  cbHud.tHp.textContent = `${Math.max(0, Math.ceil(data.hp))} / ${data.maxHp}`;
  const r = Math.max(0, data.hp / data.maxHp);
  cbHud.tHpFill.style.width = (r * 100).toFixed(1) + '%';
  cbHud.tHpFill.style.background = r > 0.5 ? '#5ddc6a' : r > 0.25 ? '#ffcc44' : '#ff5544';
  cbHud.tDmg.textContent = st.damage + (st.blastRadius ? ` (爆炸半径 ${st.blastRadius})` : '');
  cbHud.tRate.textContent = (1000 / st.fireInterval).toFixed(0) + ' 发/秒'
    + (st.powerCost ? ` · 每发耗电 ${st.powerCost}` : '');
  cbHud.tRange.textContent = `${st.minRange / CB_RANGE_CELL} - ${st.maxRange / CB_RANGE_CELL} 格`;

  const statusEl = document.getElementById('info-status');
  if (statusEl) {
    statusEl.textContent = r > 0.5 ? '● 完好' : r > 0 ? '● 受损' : '● 已摧毁';
    statusEl.style.color = r > 0.5 ? '#6f6' : r > 0 ? '#fc4' : '#f66';
  }
}
function cbSyncHUD() {
  if (!cbHud.ready) {
    cbHud.hpVal = document.getElementById('base-hp-val');
    cbHud.hpFill = document.getElementById('base-hp-fill');
    cbHud.waveEl = document.getElementById('wave-info');
    cbHud.countEl = document.getElementById('monster-count');
    cbHud.ready = true;
  }
  const hp = Math.max(0, Math.ceil(combatState.baseHp));
  if (cbHud.hpVal) cbHud.hpVal.textContent = hp;
  if (cbHud.hpFill) {
    const r = Math.max(0, combatState.baseHp / CB_BASE_MAX_HP);
    cbHud.hpFill.style.width = (r * 100).toFixed(1) + '%';
    cbHud.hpFill.style.background = r > 0.5 ? '#5ddc6a' : r > 0.25 ? '#ffcc44' : '#ff5544';
  }
  if (cbHud.waveEl) {
    const sec = Math.max(0, Math.ceil(combatState.waveTimer / 1000));
    const clock = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    const incoming = Math.max(0, combatState.spawnQueue.length - combatState.spawnIdx);
    if (combatState.waveWarned && sec <= Math.round(WAVE_WARN_MS / 1000)) {
      cbHud.waveEl.textContent = `⚠️ ${clock} 后第 ${combatState.wave + 1} 波 · ${cbDirLabel(combatState.waveDirs)}`;
      cbHud.waveEl.classList.add('warn');
    } else {
      cbHud.waveEl.textContent = `第 ${combatState.wave} 波 · 下一波 ${clock}`;
      cbHud.waveEl.classList.remove('warn');
    }
    // 仍在涌入时提示剩余待生成数量
    if (incoming > 0) cbHud.waveEl.textContent += ` · 涌入中 +${incoming}`;
  }
  if (cbHud.countEl) {
    const pending = Math.max(0, combatState.spawnQueue.length - combatState.spawnIdx);
    cbHud.countEl.textContent = pending > 0
      ? `${combatState.monsters.length} +${pending}`
      : `${combatState.monsters.length}`;
  }
  cbSyncBaseLevel();
}

// ---------- 屏幕空间 HUD（ctx.restore() 之后） ----------
function drawCombatHUD() {
  const bw = Math.min(340, canvas.width * 0.42), bh = 16;
  const bx = (canvas.width - bw) / 2, by = 60;
  const ratio = Math.max(0, combatState.baseHp / CB_BASE_MAX_HP);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);              // 确保处于屏幕空间
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = ratio > 0.5 ? '#5ddc6a' : ratio > 0.25 ? '#ffcc44' : '#ff5544';
  ctx.fillRect(bx, by, bw * ratio, bh);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`🏰 基地 ${Math.max(0, Math.ceil(combatState.baseHp))} / ${CB_BASE_MAX_HP}`, canvas.width / 2, by + bh / 2);

  // --- 电量条（基地血条下方）---
  const pw = bw * 0.6, ph = 10;
  const px = bx + (bw - pw) / 2, py = by + bh + 6;
  const cap = cbBasePowerCap();
  const pRatio = cap > 0 ? Math.max(0, Math.min(1, combatState.basePower / cap)) : 0;
  ctx.fillStyle = '#1d1d1d';
  ctx.fillRect(px, py, pw, ph);
  ctx.fillStyle = '#4de3ff';
  ctx.fillRect(px, py, pw * pRatio, ph);
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
  ctx.fillStyle = '#cfefff';
  ctx.font = 'bold 10px "Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`⚡ ${Math.floor(combatState.basePower)} / ${cap} (Lv.${combatState.baseLevel})`, px + pw / 2, py + ph / 2);

  // --- Debug 覆盖层：左上角显示 FPS 与每逻辑帧耗时 ---
  if (combatState.gameOver) {
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff5544';
    ctx.font = 'bold 52px "Microsoft YaHei",sans-serif';
    ctx.fillText('基地已被摧毁', canvas.width / 2, canvas.height / 2 - 26);
    ctx.fillStyle = '#ddd';
    ctx.font = '18px "Microsoft YaHei",sans-serif';
    ctx.fillText(`坚守 ${combatState.wave} 波 · 击杀 ${combatState.kills} 只 · 刷新页面重新开始`,
      canvas.width / 2, canvas.height / 2 + 26);
  }

  // Debug 面板最后绘制，确保不被任何遮罩盖住
  cbDrawDebugPanel();
  ctx.restore();
}

// ---------- Debug 覆盖层（Ctrl+D 开关）----------
// 固定于左上角，避开居中的血条与顶栏状态，显示实时 FPS 与每逻辑帧耗时
function cbDrawDebugPanel() {
  if (!combatState.debugMode) return;
  const dw = 276, dh = 94;
  const dx = 12, dy = 12;
  const fpsOk = combatState.spawnAllowed;   // 用门控实际放行状态，与刷怪行为一致

  ctx.fillStyle = 'rgba(0,0,0,0.66)';
  ctx.fillRect(dx, dy, dw, dh);
  ctx.strokeStyle = fpsOk ? '#5ddc6a' : '#ffcc44';
  ctx.lineWidth = 1;
  ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 13px Consolas,"Microsoft YaHei",monospace';
  ctx.fillStyle = fpsOk ? '#5ddc6a' : '#ffcc44';
  ctx.fillText(`FPS ${combatState.fps.toFixed(1)}`, dx + 10, dy + 9);
  ctx.fillStyle = '#9ad1ff';
  ctx.font = '12px Consolas,"Microsoft YaHei",monospace';
  ctx.fillText(`逻辑帧 ${combatState.logicMs.toFixed(2)} ms`, dx + 10, dy + 28);
  ctx.fillStyle = '#bbb';
  ctx.fillText(`怪物 ${combatState.monsters.length}  BOSS ${combatState.bosses.length}  波次 ${combatState.wave}`, dx + 10, dy + 46);
  ctx.fillStyle = combatState.spawnAllowed ? '#8f8' : '#f88';
  ctx.fillText(combatState.spawnAllowed ? '刷怪：放行' : '刷怪：暂停(帧率不足)', dx + 10, dy + 64);
  ctx.fillStyle = '#888';
  ctx.font = '11px "Microsoft YaHei",sans-serif';
  ctx.fillText('Ctrl+D 退出调试 · A 刷小怪 · S 刷 BOSS', dx + 10, dy + 80);
}

// ---------- 输入：鼠标世界坐标 + 调试刷怪 ----------
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  combatState.mouseWorld.x = (e.clientX - rect.left - state.panX) / state.scale;
  combatState.mouseWorld.y = (e.clientY - rect.top - state.panY) / state.scale;
});

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();

  // Ctrl+D 切换调试模式（拦截浏览器默认的「加入书签」）
  if (e.ctrlKey && k === 'd') {
    e.preventDefault();
    combatState.debugMode = !combatState.debugMode;
    showToast(combatState.debugMode ? '🐛 调试模式：开 (Ctrl+D 退出)' : '🐛 调试模式：关');
    return;
  }

  // 以下刷怪快捷键仅在调试模式下生效，避免误触
  if (!combatState.debugMode) return;
  if (!combatState.running || combatState.gameOver) return;
  const mw = combatState.mouseWorld;

  if (k === 'a') {
    // A：在鼠标世界坐标处刷一小群小怪
    for (let i = 0; i < 20; i++) {
      cbAddMonster(mw.x + (Math.random() - 0.5) * 60, mw.y + (Math.random() - 0.5) * 60, false);
    }
  } else if (k === 's') {
    // S：在鼠标处刷一只 BOSS，血量按当前波次计算
    cbAddMonster(mw.x, mw.y, true, cbBossHpFor(Math.max(1, combatState.wave)));
    showToast(`👹 BOSS 已生成（血量 ${cbBossHpFor(Math.max(1, combatState.wave)).toLocaleString()}）`);
  }
});
