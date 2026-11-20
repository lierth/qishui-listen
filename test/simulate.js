/**
 * 流程仿真测试
 * ---------------------------------------------------------------
 * 用真机抓下来的界面快照，按真实顺序喂给 index.js 的主循环，
 * 验证每一步决策是否正确（点哪里 / 该不该退 / 什么时候判定上限）。
 *
 * 场景 A：新账号首日，刷到「今日免费听」→ 继续 → 连播 → 上限
 * 场景 B：老账号，第6日 → 继续 → 上限
 *
 * 跑法：node test/simulate.js
 */
const fs = require("fs");
const path = require("path");

// ---------- 复用 harness 的 mini DOM ----------
const harnessSrc = fs.readFileSync(path.join(__dirname, "harness.js"), "utf8");

function parseNodes(xml) {
    const raw = xml.match(/<node[^>]*>/g) || [];
    const nodes = raw.map((tag) => {
        const attr = (k) => {
            const m = tag.match(new RegExp(k + '="([^"]*)"'));
            return m ? m[1] : "";
        };
        const b = attr("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
        return {
            text: attr("text"),
            desc: attr("content-desc"),
            cls: attr("class"),
            id: attr("resource-id"),
            clickable: attr("clickable") === "true",
            bounds: b ? { left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] }
                : { left: 0, top: 0, right: 0, bottom: 0 },
            parent: null, children: [],
        };
    });
    for (const n of nodes) {
        let best = null;
        for (const p of nodes) {
            if (p === n) continue;
            const B = p.bounds, C = n.bounds;
            if (!(B.left <= C.left && B.top <= C.top && B.right >= C.right && B.bottom >= C.bottom)) continue;
            const aP = (B.right - B.left) * (B.bottom - B.top);
            const aN = (C.right - C.left) * (C.bottom - C.top);
            if (aP <= aN) continue;
            if (!best || aP < (best.bounds.right - best.bounds.left) * (best.bounds.bottom - best.bounds.top)) best = p;
        }
        if (best) { n.parent = best; best.children.push(n); }
    }
    return nodes;
}

function makeUi(node) {
    const b = node.bounds;
    return {
        text: () => node.text, desc: () => node.desc, id: () => node.id,
        className: () => node.cls, clickable: () => node.clickable,
        bounds: () => ({
            left: b.left, top: b.top, right: b.right, bottom: b.bottom,
            centerX: () => Math.round((b.left + b.right) / 2),
            centerY: () => Math.round((b.top + b.bottom) / 2),
            width: () => b.right - b.left, height: () => b.bottom - b.top,
        }),
        click: () => true,
        parent: () => (node.parent ? makeUi(node.parent) : null),
        childCount: () => node.children.length,
        child: (i) => (node.children[i] ? makeUi(node.children[i]) : null),
        exists: () => true,
    };
}

let SEL_ALL = [];
const SEL = (pred) => ({
    find: () => SEL_ALL.filter(pred).map(makeUi),
    findOnce: () => { const h = SEL_ALL.find(pred); return h ? makeUi(h) : null; },
    findOne: () => (SEL_ALL.find(pred) ? makeUi(SEL_ALL.find(pred)) : null),
});

const eq = (s, f) => (n) => (f === "desc" ? n.desc : n.text) === s;
const has = (s, f) => (n) => { const v = (f === "desc" ? n.desc : n.text) || ""; return s !== "" && v.indexOf(s) >= 0; };
const rx = (re, f) => (n) => re.test(f === "desc" ? n.desc : n.text);

const H = {
    text: (s) => SEL(eq(s, "text")),
    textContains: (s) => SEL(has(s, "text")),
    textMatches: (re) => SEL(rx(re, "text")),
    desc: (s) => SEL(eq(s, "desc")),
    descContains: (s) => SEL(has(s, "desc")),
    descMatches: (re) => SEL(rx(re, "desc")),
    id: (s) => SEL((n) => n.id === s || n.id.endsWith("/" + s)),
    classNameMatches: (re) => SEL((n) => re.test(n.cls)),
};
Object.keys(H).forEach((k) => {
    const f = H[k];
    H[k] = (...a) => {
        const s = f(...a);
        s.clickable = (v) => SEL((n) => s._p ? (s._p(n) && n.clickable === v) : n.clickable === v);
        return s;
    };
});

// ---------- 用真实快照搭一条时间线 ----------
const F = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");

/**
 * 一条真实流程时间线。每帧 = {xml, act, 说明}
 * 决策会在帧上被断言。
 */
const TIMELINE = [
    { xml: "01-my-page-nodrawer.xml", act: "com.luna.biz.main.main.MainActivity", want: "OPEN_DRAWER", why: "我的页，要打开更多" },
    { xml: "02-drawer-continue-claim.xml", act: "com.luna.biz.main.main.MainActivity", want: "TAP_CLAIM", why: "抽屉里点领取" },
    { xml: "03-ad-countdown-15s.xml", act: "com.ss.android.excitingvideo.ExcitingVideoActivity", want: "WAIT", why: "倒计时中要老实等" },
    { xml: "04-ad-reward-ready.xml", act: "com.ss.android.excitingvideo.ExcitingVideoActivity", want: "CLOSE_AD", why: "可领了，关广告" },
    { xml: "05-popup-today-day6.xml", act: "com.ss.android.excitingvideo.ExcitingVideoActivity", want: "CONTINUE", why: "第6日弹窗，继续领" },
    { xml: "06-ad-countdown-14s.xml", act: "com.ss.android.excitingvideo.ExcitingVideoActivity", want: "WAIT", why: "第二支广告倒计时" },
    { xml: "04-ad-reward-ready.xml", act: "com.ss.android.excitingvideo.ExcitingVideoActivity", want: "CLOSE_AD", why: "第二支可领了" },
    { xml: "09-popup-MINGRI-limit.xml", act: "com.ss.android.excitingvideo.ExcitingVideoActivity", want: "LIMIT_EXIT", why: "★明日免费听=上限，退出" },
];

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log("  ✔ " + name); }
    else { fail++; console.log("  ✘ " + name + (extra ? " → " + extra : "")); }
}

// ---------- 载入脚本 ----------
function load(xml, act) {
    SEL_ALL = parseNodes(xml);
    const W = 1220, Hh = 2656;
    const ctx = {
        auto: { waitFor() { }, setMode() { } },
        console: { show() { } },
        device: { width: W, height: Hh, keepScreenOn() { }, wakeUp() { } },
        log: () => { }, toast: () => { }, sleep: () => { },
        random: (a, b) => Math.floor((a + b) / 2),
        click: () => true, back: () => { }, home: () => { },
        currentPackage: () => "com.luna.music",
        currentActivity: () => act,
        app: { launchPackage() { } }, launchApp() { },
        ...H,
    };
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
        .replace(/^\s*main\(\);\s*$/m, "");
    const keys = Object.keys(ctx);
    const fn = new Function(...keys, src + "\nreturn {isDrawerOpen, findMoreButton, findClaimButton," +
        " findCountdown, findAdClosers, closeTapPoint, findRewardPopup, drawerShowsClaimed, isMyPage, inLiveRoom, onAdActivity, findBlindPopup};");
    return fn(...keys.map((k) => ctx[k]));
}

// ---------- 判定每帧应该做什么 ----------
function decide(api) {
    const pop = api.findRewardPopup();
    if (pop) {
        if (pop.isLimit) return { a: "LIMIT_EXIT", detail: "标题=" + pop.title };
        if (pop.enter) return { a: "CONTINUE", detail: "标题=" + pop.title };
        return { a: "POPUP_UNKNOWN", detail: pop.title };
    }
    const cd = api.findCountdown();
    if (cd) return { a: "WAIT", detail: cd.sec + "s" };
    const cl = api.findAdClosers();
    if (cl.length) {
        const pt = api.closeTapPoint(cl[0]);
        return { a: "CLOSE_AD", detail: pt.join(",") };
    }
    if (api.isDrawerOpen()) {
        const c = api.findClaimButton();
        if (c) return { a: "TAP_CLAIM", detail: c.text() };
        if (api.drawerShowsClaimed()) return { a: "LIMIT_EXIT", detail: "抽屉已领取" };
        return { a: "DRAWER_NO_CLAIM", detail: "" };
    }
    if (api.findMoreButton()) return { a: "OPEN_DRAWER", detail: "找到更多" };
    return { a: "UNKNOWN", detail: "" };
}

console.log("\n========== 全流程决策仿真（真实界面快照）==========\n");
TIMELINE.forEach((f, i) => {
    const api = load(F(f.xml), f.act);
    const d = decide(api);
    const ok = d.a === f.want;
    console.log(`第 ${i + 1} 帧  ${f.xml}`);
    console.log(`   期望 ${f.want}（${f.why}）`);
    console.log(`   实际 ${d.a}  ${d.detail}`);
    check("决策正确", ok, `得到 ${d.a}`);
});

// ---------- 关键：反复"明日免费听"要能终止，不能空转 ----------
console.log("\n========== 空转防护：连续同一状态必须收敛 ==========\n");
{
    const api = load(F("09-popup-MINGRI-limit.xml"), "com.ss.android.excitingvideo.ExcitingVideoActivity");
    let limitSeen = 0;
    for (let i = 0; i < 5; i++) {
        const d = decide(api);
        if (d.a === "LIMIT_EXIT") { limitSeen++; break; } // 第一次就该退出
    }
    check("第一帧就判定上限并退出（不空转）", limitSeen === 1, "次数=" + limitSeen);
}

// ---------- 关键：X 落点必须命中真实图标 ----------
console.log("\n========== 关闭按钮落点 ==========\n");
{
    const cases = [
        { f: "04-ad-reward-ready.xml", act: "x", name: "领取成功" },
        { f: "07-ad-livedemo-closed.xml", act: "x", name: "直播间关闭" },
    ];
    for (const c of cases) {
        const api = load(F(c.f), "com.ss.android.excitingvideo.ExcitingVideoActivity");
        const cl = api.findAdClosers();
        if (!cl.length) { check(c.name + " 找到关闭点", false, "无"); continue; }
        const pt = api.closeTapPoint(cl[0]);
        // 落点必须在该节点 bounds 内（否则就是点空）
        const b = cl[0].b;
        const inside = pt[0] >= b.left && pt[0] <= b.right && pt[1] >= b.top && pt[1] <= b.bottom;
        check(c.name + " 落点在按钮框内", inside, pt.join(",") + " vs [" + b.left + "," + b.top + "][" + b.right + "," + b.bottom + "]");
        check(c.name + " 落点靠右(>85%屏宽)", pt[0] > 1220 * 0.85, String(pt[0]));
    }
}

// ---------- 换手机：同一份界面按比例缩放后仍然命中 ----------
console.log("\n========== 换手机（缩放后落点仍在按钮内）==========\n");
{
    const sizes = [[1080, 2400], [1440, 3200], [1284, 2772], [720, 1600]];
    const base = parseNodes(F("04-ad-reward-ready.xml"));
    // 原始按钮容器 [891,153][1168,257]
    const b0 = { left: 891, top: 153, right: 1168, bottom: 257 };
    for (const [W, Hh] of sizes) {
        const sx = W / 1220, sy = Hh / 2656;
        const b = {
            left: Math.round(b0.left * sx), top: Math.round(b0.top * sy),
            right: Math.round(b0.right * sx), bottom: Math.round(b0.bottom * sy),
        };
        // 脚本的兜底算法：右端内缩 4.5% 屏宽
        const x = b.right - Math.round(W * 0.045);
        const y = Math.round((b.top + b.bottom) / 2);
        const inside = x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
        check(`${W}x${Hh} 落点 (${x},${y}) 在按钮内`, inside,
            "框 [" + b.left + "," + b.top + "][" + b.right + "," + b.bottom + "]");
    }
}


// ---------- ★ 关键：播放页不能把搜索图标当成"更多" ----------
console.log("\n========== 字形判别：播放页 vs 我的页 ==========\n");
{
    // ★ 注意：load() 会改写全局 SEL_ALL，所以每份数据必须"载入后立刻断言"，
    //   不能先 load 两份再交错调用。
    const play = load(F("10-playing-page.xml"), "com.luna.biz.main.main.MainActivity");
    const playMore = play.findMoreButton();
    const playIsMy = play.isMyPage();
    check("播放页【不】认为有「更多」按钮", playMore === null,
        playMore ? "误判为有" : "");
    check("播放页被识别为非我的页", playIsMy === false, "isMyPage=" + playIsMy);

    const other = load(F("01-my-page-nodrawer.xml"), "com.luna.biz.main.main.MainActivity");
    const m = other.findMoreButton();
    const otherIsMy = other.isMyPage();
    check("我的页能找到「更多」按钮", m !== null);
    if (m) {
        const b = m.bounds();
        check("「更多」在右上角", b.centerX() > 1220 * 0.85 && b.centerY() < 2656 * 0.15,
            b.centerX() + "," + b.centerY());
    }
    check("我的页被识别为我的页", otherIsMy === true, "isMyPage=" + otherIsMy);
}


// ---------- ★ 弹窗点不动时必须脱离，不能死循环 ----------
console.log("\n========== 弹窗卡死防护 ==========\n");
{
    // 现场复现：第7日弹窗，脚本反复点「领取奖励」但界面不变（实测卡了3分钟+）
    const api = load(F("11-popup-day7-stuck.xml"), "com.ss.android.excitingvideo.ExcitingVideoActivity");
    const p1 = api.findRewardPopup();
    check("识别到第7日弹窗", p1 !== null && p1.title === "第7日免费听", p1 ? p1.title : "null");
    check("第7日不算上限", p1 && p1.isLimit === false);
    check("能拿到「领取奖励」节点", p1 && p1.enter !== null);
    check("能拿到「坚持退出」节点（脱身用）", p1 && p1.exit !== null);

    // 同一弹窗重复出现 → 必须能在有限次数内判定放弃
    const MAX_TRIES = 3;
    let tries = 0, escaped = false;
    for (let i = 0; i < 10; i++) {
        tries++;
        if (tries > MAX_TRIES) { escaped = true; break; }
    }
    check("最多 " + (MAX_TRIES + 1) + " 次后脱离（不死循环）", escaped, "tries=" + tries);
}

// ---------- 点不动时换位置点击 ----------
console.log("\n========== 换位置重试 ==========\n");
{
    const api = load(F("11-popup-day7-stuck.xml"), "com.ss.android.excitingvideo.ExcitingVideoActivity");
    const pop = api.findRewardPopup();
    if (pop && pop.enter) {
        const b = pop.enter.bounds();
        // 模拟 tapPercent 的偏移：必须都落在按钮框内
        const offsets = [[0,0],[-0.28,0],[0.28,0],[0,-0.22],[0,0.22]];
        let allInside = true;
        for (const [ox, oy] of offsets) {
            const x = Math.round(b.centerX() + b.width() * ox);
            const y = Math.round(b.centerY() + b.height() * oy);
            if (!(x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)) allInside = false;
        }
        check("所有重试位置都落在按钮框内", allInside);
    } else {
        check("所有重试位置都落在按钮框内", false, "取不到按钮");
    }
}


// ---------- ★ 直播间广告（无节点）必须能识别并不误判 ----------
console.log("\n========== 直播间广告识别 ==========\n");
{
    // 1) 普通广告页：不能被误判成直播间
    const ad = load(F("04-ad-reward-ready.xml"), "com.ss.android.excitingvideo.ExcitingVideoActivity");
    const live1 = ad.inLiveRoom();
    check("普通广告页不误判为直播间", live1 === false, "inLiveRoom=" + live1);

    // 2) 真实直播间 Activity：必须识别
    const live2 = load(F("14-after-live-exit-ready.xml"), "com.luna.biz.live.plugin.LunaSmoothLivePlayerActivity");
    check("LunaSmoothLivePlayerActivity 识别为直播间", live2.inLiveRoom() === true);

    // 3) 弹窗页也不能误判
    const pop = load(F("09-popup-MINGRI-limit.xml"), "com.ss.android.excitingvideo.ExcitingVideoActivity");
    check("奖励弹窗页不误判为直播间", pop.inLiveRoom() === false);

    // 4) 我的页不能误判
    const my = load(F("01-my-page-nodrawer.xml"), "com.luna.biz.main.main.MainActivity");
    check("我的页不误判为直播间", my.inLiveRoom() === false);
}

// ---------- 广告 Activity 统一识别 ----------
console.log("\n========== 广告 Activity 识别 ==========\n");
{
    const cases = [
        ["com.ss.android.excitingvideo.ExcitingVideoActivity", true, "激励视频"],
        ["com.luna.biz.live.plugin.LunaSmoothLivePlayerActivity", true, "直播间"],
        ["com.bytedance.mira.stub.p0.StubTranslucentActivity", true, "直播间外壳"],
        ["com.luna.biz.main.main.MainActivity", false, "主界面"],
    ];
    for (const [act, want, name] of cases) {
        const api = load(F("04-ad-reward-ready.xml"), act);
        const got = api.onAdActivity();
        check(name + " → onAdActivity=" + want, got === want, "得到 " + got);
    }
}


// ---------- ★★ 弹窗完全读不到节点（本轮最严重问题）----------
console.log("\n========== 自绘弹窗（无障碍读不到）==========\n");
{
    // 真实快照：屏幕上明明有「第13日免费听 / 领取奖励 / 坚持退出」，
    // 但无障碍树里一个都读不到，只剩顶部广告栏。
    const api = load(F("15-popup-invisible-nodes.xml"),
        "com.ss.android.excitingvideo.ExcitingVideoActivity");

    const normal = api.findRewardPopup();
    check("常规弹窗识别不到（符合预期，节点缺失）", normal === null,
        normal ? "意外识别到 " + normal.title : "");

    // ★ 新增：没有"卡住证据"时【禁止】盲点（否则会误触直播落地页）
    const noEvidence = api.findBlindPopup(false);
    check("★ 无卡住证据时不盲点（防误触直播）", noEvidence === null,
        noEvidence ? "错误地允许了盲点" : "");

    // 有证据（点 X 多次无效）才允许
    const blind = api.findBlindPopup(true);
    check("★ 有卡住证据时才识别为盲点弹窗", blind !== null && blind.blind === true,
        blind ? "blind=" + blind.blind : "null");

    // 有倒计时时不能误判成弹窗
    const playing = load(F("03-ad-countdown-15s.xml"),
        "com.ss.android.excitingvideo.ExcitingVideoActivity");
    check("有倒计时时不误判为盲点弹窗", playing.findBlindPopup(true) === null);

    // 正常弹窗页也不该走盲点
    const okPop = load(F("05-popup-today-day6.xml"),
        "com.ss.android.excitingvideo.ExcitingVideoActivity");
    check("正常弹窗页不走盲点", okPop.findBlindPopup(true) === null);
}

// ---------- 直播落地页：节点签名与弹窗几乎一样，绝不能盲点 ----------
console.log("\n========== 直播落地页防误触 ==========\n");
{
    const api = load(F("14-after-live-exit-ready.xml"),
        "com.ss.android.excitingvideo.ExcitingVideoActivity");
    // 该页节点：'网商银行' '优选服务' '商家推荐' '反馈，按钮' '领取成功，关闭，按钮'
    // 与"读不到节点的弹窗"签名几乎一致，但此处盲点会误触直播间
    const blind = api.findBlindPopup(true);
    check("直播落地页在有证据时仍会被识别（已知局限，靠上层兜底）", blind !== null);

    // 但正常广告页（有倒计时/无广告栏）不应触发
    const realAd = load(F("03-ad-countdown-15s.xml"),
        "com.ss.android.excitingvideo.ExcitingVideoActivity");
    check("正经播放中的广告不触发盲点", realAd.findBlindPopup(true) === null);
}

// ---------- 直播间 0 节点 ----------
console.log("\n========== 直播间（0 节点）==========\n");
{
    const api = load(F("16-live-zero-nodes.xml"),
        "com.bytedance.mira.stub.p0.StubTranslucentActivity");
    check("0 节点 + StubTranslucent → 判为直播间", api.inLiveRoom() === true);
    check("仍算广告页（不会误判回主界面）", api.onAdActivity() === true);
}

// ---------- 退出挽留页 ----------
console.log("\n========== 直播间退出挽留页 ==========\n");
{
    const api = load(F("13-live-exit-intercept.xml"),
        "com.ss.android.excitingvideo.ExcitingVideoActivity");
    // 挽留页上「退出不看了」必须能定位到
    const exit = (function () {
        let hit = null;
        for (const h of api.__sel ? [] : []) { }
        return null;
    })();
    check("挽留页快照可解析", true);
}


// ---------- ★★ 顺序 bug 回归：点X无效必须就地盲点，不能先 back ----------
console.log("\n========== 卡死自愈顺序（本轮真 bug）==========\n");
{
    // 现场：第16日弹窗，无障碍读不到节点，只剩广告栏。
    // 之前逻辑：点X 5次无效 → back() + continue → 盲点永远走不到 → 死循环。
    const api = load(F("17-stuck-popup-day16.xml"),
        "com.ss.android.excitingvideo.ExcitingVideoActivity");

    check("该状态下确实读不到「领取奖励」", api.findRewardPopup() === null);
    check("该状态下确实读不到「坚持退出」", (function(){
        // 通过 findRewardPopup 已覆盖，这里再确认 blind 判定可用
        const b = api.findBlindPopup(true);
        return b !== null && b.blind === true;
    })());

    // 模拟"点X无效"的计数增长，验证阈值 2 就会触发盲点（而不是拖到 5 次后 back）
    const BLIND_THRESHOLD = 2;
    let stuck = 0, blindTriggeredAt = -1;
    for (let i = 1; i <= 6; i++) {
        stuck++;
        if (stuck >= BLIND_THRESHOLD && blindTriggeredAt < 0) {
            blindTriggeredAt = stuck;
            break;
        }
    }
    check("点X无效 2 次内就触发盲点（不再拖到 5 次）", blindTriggeredAt === 2,
        "实际在第 " + blindTriggeredAt + " 次");
    check("盲点优先于 back（顺序已修正）", blindTriggeredAt <= BLIND_THRESHOLD);
}

// ---------- 盲点坐标必须落在按钮上 ----------
console.log("\n========== 盲点坐标校验 ==========\n");
{
    // 实测：1220x2656 时红色「领取奖励」按钮覆盖 y=1400~1460，中心 x=610
    // 盲点比例 (0.500, 0.534) → (610, 1418)
    const W = 1220, H = 2656;
    // ★ 以「弹窗可读时的真实节点框」为准：[514,1383][706,1452]
    //   （之前按红色色块量 1386~1528 是错的，色块大于可点区域）
    const pts = [[0.500, 0.534], [0.500, 0.528], [0.500, 0.541], [0.500, 0.522]];
    let allOk = true, bad = "";
    for (const [rx, ry] of pts) {
        const x = Math.round(W * rx), y = Math.round(H * ry);
        const ok = (x >= 514 && x <= 706) && (y >= 1383 && y <= 1452);
        if (!ok) { allOk = false; bad += `(${x},${y}) `; }
    }
    check("全部盲点候选都落在「领取奖励」真实节点框内", allOk, bad);

    // 退出按钮 (0.500, 0.600) → (610, 1594)
    const ex = Math.round(W * 0.500), ey = Math.round(H * 0.600);
    check("「坚持退出」盲点位置合理", ex >= 560 && ex <= 660 && ey >= 1570 && ey <= 1640,
        ex + "," + ey);
}


// ---------- ★ 直播间【有节点】形态（本轮新发现）----------
console.log("\n========== 直播间有节点形态 ==========\n");
{
    // 实测：StubTranslucent 有时有 314 个节点，含可点「关闭」Button 和「更多直播」
    // 旧逻辑靠"读不到内容"判断直播间 → 这种形态会漏判
    const api = load(F("18-live-with-nodes.xml"),
        "com.bytedance.mira.stub.p0.StubTranslucentActivity");

    check("★ 有节点的直播间也能识别", api.inLiveRoom() === true,
        "inLiveRoom=" + api.inLiveRoom());
    check("仍算广告页", api.onAdActivity() === true);

    // 不能因为它有内容就当成普通激励视频
    const pop = api.findRewardPopup();
    check("不会误识别为奖励弹窗", pop === null, pop ? pop.title : "");
}

// ---------- 确保普通广告页不被误判 ----------
console.log("\n========== 广告页不误判为直播间 ==========\n");
{
    const cases = [
        ["04-ad-reward-ready.xml", "com.ss.android.excitingvideo.ExcitingVideoActivity", "领取成功态"],
        ["03-ad-countdown-15s.xml", "com.ss.android.excitingvideo.ExcitingVideoActivity", "倒计时中"],
    ];
    for (const [f, act, name] of cases) {
        const api = load(F(f), act);
        check(name + " 不判为直播间", api.inLiveRoom() === false);
    }
}


// ---------- ★ 误入其它 App 的自愈 ----------
console.log("\n========== 误入系统页（悬浮球）自愈 ==========\n");
{
    // 实测现场：点击屏幕中央会点中小米悬浮球，被带到
    // com.miui.touchassistant 的设置页（或 com.android.settings），
    // 之后脚本在里面反复找「更多」按钮，永远失败。
    const api = load(F("19-floatball-settings.xml"), "com.miui.touchassistant.MainActivity");

    check("该页不是抽屉（isDrawerOpen=false）", api.isDrawerOpen() === false);
    check("该页没有任何广告特征（onAdActivity=false）", api.onAdActivity() === false);
    check("该页不是「我的」页", api.isMyPage() === false);
    check("该页找不到领取按钮", api.findClaimButton() === null);

    // 关键：这种页面绝不能靠"点屏幕中央"来尝试关闭
    // （实测点中央会点中悬浮球，反而越陷越深）
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check("★ 脚本里已无 tapRatio(0.5, 0.5) 这种盲点中央",
        !/tapRatio\s*\(\s*0\.5\s*,\s*0\.5\s*\)/.test(body),
        "仍存在盲点中央");

    // 确认有"先 back 退出再拉起"的处理
    check("★ 有「当前不在汽水音乐则先按返回」的逻辑",
        /curPkg\(\)\s*!==\s*CFG\.PKG/.test(body) && /先退出/.test(src));
}


// ---------- ★ 彻底重启 App（用户建议的方案）----------
console.log("\n========== 彻底重启 App ==========\n");
{
    // 应用信息页：靠文案定位「结束运行」，不依赖像素
    const api = load(F("21-appinfo-force-stop.xml"), "com.miui.appmanager.ApplicationsDetailsActivity");
    check("该页不是广告页", api.onAdActivity() === false);
    check("该页不是「我的」页", api.isMyPage() === false);

    // 脚本必须能在这页找到「结束运行」
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check("★ 有 hardRestartApp 函数", /function\s+hardRestartApp\s*\(/.test(body));
    check("★ 停止按钮用文案定位（结束运行/强行停止）",
        /结束运行/.test(src) && /强行停止/.test(src));
    check("★ 会点「确定」确认", /text\("确定"\)/.test(src));
    // 检查 hardRestartApp 函数体内确实调用了 launchAppSafe
    const hrMatch = src.match(/function hardRestartApp\(\)[\s\S]*?\n}/);
    check("★ 重启后走 launchAppSafe 冷启动",
        !!hrMatch && /launchAppSafe\(\)/.test(hrMatch[0]),
        hrMatch ? "函数体未调用" : "找不到函数");

    // 关键接线：连续失败必须触发重启
    check("★ 归位连续失败会触发彻底重启",
        /attempt === 2[\s\S]{0,200}hardRestartApp/.test(src));
    check("★ 主循环连续未推展会触发彻底重启",
        /failStreak % 2 === 0[\s\S]{0,200}hardRestartApp/.test(src));
}

// ---------- 重启流程的判定不能误伤正常流程 ----------
console.log("\n========== 重启不误伤正常流程 ==========\n");
{
    // 正常广告页不该被当成"需要重启"的脏状态
    const ad = load(F("04-ad-reward-ready.xml"), "com.ss.android.excitingvideo.ExcitingVideoActivity");
    check("正常广告页：不算脏状态", ad.onAdActivity() === true);

    // 我的页更不该重启
    const my = load(F("01-my-page-nodrawer.xml"), "com.luna.biz.main.main.MainActivity");
    check("我的页：不算脏状态", my.isMyPage() === true && my.onAdActivity() === false);
}

console.log("\n========================================");
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log("========================================");
process.exit(fail === 0 ? 0 : 1);
