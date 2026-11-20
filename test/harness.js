/**
 * 离线验证 harness
 * ---------------------------------------------------------------
 * 不连手机，用真机抓下来的 UI dump（test/fixtures/*.xml）
 * 模拟 Hamibot 的 selector / UiObject API，跑 index.js 里真实的
 * 识别函数，确认每一份真实界面都能被正确识别。
 *
 * 跑法：node test/harness.js
 */

const fs = require("fs");
const path = require("path");

// ===================== 迷你 XML 解析 =====================
function parseNodes(xml) {
    const raw = xml.match(/<node[^>]*>/g) || [];
    const nodes = [];
    const stack = [];
    // 按文档顺序重建父子关系（出现顺序即深度优先前序）
    // 用简单规则：维护深度，靠 index 属性 + 元素闭合不太可靠，
    // 这里靠"下一个节点的起点在上一个节点内部"来推算父子。
    raw.forEach((tag, i) => {
        const attr = (k) => {
            const m = tag.match(new RegExp(k + '="([^"]*)"'));
            return m ? m[1] : "";
        };
        const b = attr("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
        const node = {
            _i: i,
            text: attr("text"),
            desc: attr("content-desc"),
            cls: attr("class"),
            id: attr("resource-id"),
            clickable: attr("clickable") === "true",
            bounds: b
                ? { left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] }
                : { left: 0, top: 0, right: 0, bottom: 0 },
            parent: null,
            children: [],
        };
        nodes.push(node);
    });
    // 用 bounds 包含关系建立父子（对 UI dump 足够准）
    for (const n of nodes) {
        let best = null;
        for (const p of nodes) {
            if (p === n) continue;
            const B = p.bounds, C = n.bounds;
            const contains =
                B.left <= C.left && B.top <= C.top && B.right >= C.right && B.bottom >= C.bottom;
            if (!contains) continue;
            const areaP = (B.right - B.left) * (B.bottom - B.top);
            const areaN = (C.right - C.left) * (C.bottom - C.top);
            if (areaP <= areaN) continue; // 同尺寸不算父
            if (!best || areaP < (best.bounds.right - best.bounds.left) * (best.bounds.bottom - best.bounds.top)) {
                best = p;
            }
        }
        if (best) { n.parent = best; best.children.push(n); }
    }
    return nodes;
}

// ===================== 模拟 Hamibot UiObject =====================
function makeUi(node) {
    const b = node.bounds;
    return {
        _n: node,
        text: () => node.text,
        desc: () => node.desc,
        id: () => node.id,
        className: () => node.cls,
        clickable: () => node.clickable,
        bounds: () => ({
            left: b.left, top: b.top, right: b.right, bottom: b.bottom,
            centerX: () => Math.round((b.left + b.right) / 2),
            centerY: () => Math.round((b.top + b.bottom) / 2),
            width: () => b.right - b.left,
            height: () => b.bottom - b.top,
        }),
        click: () => true,
        parent: () => (node.parent ? makeUi(node.parent) : null),
        childCount: () => node.children.length,
        child: (i) => (node.children[i] ? makeUi(node.children[i]) : null),
        exists: () => true,
    };
}

// ===================== 模拟 selector =====================
function makeSelector(pred, label) {
    const sel = {
        _pred: pred,
        _label: label,
        find: () => SEL_ALL.filter(pred).map(makeUi),
        findOnce: () => {
            const hit = SEL_ALL.find(pred);
            return hit ? makeUi(hit) : null;
        },
        findOne: () => sel.findOnce(),
    };
    return sel;
}

let SEL_ALL = [];

const H = {};
function defPred(name, build) {
    H[name] = (...args) => makeSelector(build(...args), name + JSON.stringify(args));
}

const rxText = (re, field) => (n) => re.test(field === "desc" ? n.desc : n.text);
const eqText = (s, field) => (n) => (field === "desc" ? n.desc : n.text) === s;
const hasText = (s, field) => (n) => { const v = ((field === "desc" ? n.desc : n.text) || ""); return s !== "" && v.indexOf(s) >= 0; };

// text / textContains / textMatches / desc / descContains / descMatches / id / classNameMatches
defPred("text", (s) => eqText(s, "text"));
defPred("textContains", (s) => hasText(s, "text"));
defPred("textMatches", (re) => rxText(re, "text"));
defPred("desc", (s) => eqText(s, "desc"));
defPred("descContains", (s) => hasText(s, "desc"));
defPred("descMatches", (re) => rxText(re, "desc"));
defPred("id", (s) => (n) => n.id === s || n.id.endsWith("/" + s));
defPred("classNameMatches", (re) => (n) => re.test(n.cls));

// 支持 .clickable(true)
const origMake = makeSelector;
Object.keys(H).forEach((k) => {
    const fn = H[k];
    H[k] = (...a) => {
        const s = fn(...a);
        s.clickable = (v) => makeSelector((n) => s._pred(n) && n.clickable === v, s._label + ":clickable");
        return s;
    };
});

// ===================== 运行环境 =====================
function loadIndex(xmlPath, screen) {
    SEL_ALL = parseNodes(fs.readFileSync(xmlPath, "utf8"));
    const W = screen.w, Hh = screen.h;

    const logs = [];
    const actions = [];

    const ctx = {
        W, H: Hh,
        auto: { waitFor() {}, setMode() {} },
        console: { show() {} },
        device: { width: W, height: Hh, keepScreenOn() {}, wakeUp() {} },
        log: (m) => logs.push(String(m)),
        toast: (m) => logs.push("[toast] " + m),
        sleep: () => {},
        random: (a, b) => Math.floor((a + b) / 2),
        click: (x, y) => { actions.push({ type: "click", x, y }); return true; },
        back: () => actions.push({ type: "back" }),
        home: () => actions.push({ type: "home" }),
        currentPackage: () => screen.pkg || "com.luna.music",
        currentActivity: () => screen.act || "com.luna.biz.main.main.MainActivity",
        app: { launchPackage() {} },
        launchApp() {},
        ...H,
    };

    // 把 index.js 的源码包进一个函数，注入 ctx，只取出需要的函数
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    // 去掉最后的 main() 调用，避免自动执行
    const body = src.replace(/^\s*main\(\);\s*$/m, "");

    const keys = Object.keys(ctx);
    const fn = new Function(...keys, body + "\nreturn {isDrawerOpen, findMoreButton, findClaimButton," +
        " drawerShowsClaimed, findCountdown, findAdClosers, closeTapPoint, findRewardPopup," +
        " popupHint, ensureDrawerReady, openDrawer, tapMyTab, findPopupClaimNode, adBarX, CFG, W, H};");
    const api = fn(...keys.map((k) => ctx[k]));
    return { api, logs, actions };
}

// ===================== 断言 =====================
let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log("  ✔ " + name); }
    else { fail++; console.log("  ✘ " + name + (extra ? "  → " + extra : "")); }
}

const F = (n) => path.join(__dirname, "fixtures", n);

// ---------- 用例 ----------
console.log("\n=== 01 我的页（抽屉未开）===");
{
    const { api } = loadIndex(F("01-my-page-nodrawer.xml"), { w: 1220, h: 2656 });
    check("抽屉未打开", api.isDrawerOpen() === false);
    check("能找到「更多」按钮", api.findMoreButton() !== null,
        api.findMoreButton() ? "" : "未找到");
    if (api.findMoreButton()) {
        const b = api.findMoreButton().bounds();
        check("「更多」在右上角", b.centerX() > 1220 * 0.85 && b.centerY() < 2656 * 0.15,
            b.centerX() + "," + b.centerY());
    }
    check("此时没有领取按钮", api.findClaimButton() === null);
}

console.log("\n=== 02 抽屉（继续领）===");
{
    const { api } = loadIndex(F("02-drawer-continue-claim.xml"), { w: 1220, h: 2656 });
    check("抽屉已打开", api.isDrawerOpen() === true);
    const c = api.findClaimButton();
    check("找到领取按钮", c !== null);
    if (c) {
        check("文案是「继续领」", c.text() === "继续领", c.text());
        const b = c.bounds();
        check("位置在上半屏偏右", b.centerX() > 1220 * 0.6 && b.centerY() < 2656 * 0.32,
            b.centerX() + "," + b.centerY());
    }
}

console.log("\n=== 03 广告倒计时 15s ===");
{
    const { api } = loadIndex(F("03-ad-countdown-15s.xml"), { w: 1220, h: 2656, act: "com.ss.android.excitingvideo.ExcitingVideoActivity" });
    const cd = api.findCountdown();
    check("识别到倒计时", cd !== null);
    if (cd) check("倒计时秒数=15", cd.sec === 15, String(cd.sec));
    check("倒计时期间不点关闭", api.findAdClosers().length === 0,
        "误判 " + api.findAdClosers().length + " 个关闭点");
    check("没有奖励弹窗", api.findRewardPopup() === null);
}

console.log("\n=== 04 广告可领取（领取成功，关闭，按钮）===");
{
    const { api } = loadIndex(F("04-ad-reward-ready.xml"), { w: 1220, h: 2656, act: "com.ss.android.excitingvideo.ExcitingVideoActivity" });
    check("没有倒计时", api.findCountdown() === null);
    const cl = api.findAdClosers();
    check("识别到关闭按钮", cl.length > 0, String(cl.length));
    if (cl.length) {
        const pt = api.closeTapPoint(cl[0]);
        // 真机实测 X 图标中心 = (1114,205)
        const ok = Math.abs(pt[0] - 1114) <= 20 && Math.abs(pt[1] - 205) <= 20;
        check("关闭点落在真实 X 上(1114,205)", ok, pt.join(","));
    }
}

console.log("\n=== 05 奖励弹窗：今日/第6日（未达上限）===");
{
    const { api } = loadIndex(F("05-popup-today-day6.xml"), { w: 1220, h: 2656, act: "com.ss.android.excitingvideo.ExcitingVideoActivity" });
    const p = api.findRewardPopup();
    check("识别到奖励弹窗", p !== null);
    if (p) {
        check("标题=第6日免费听", p.title === "第6日免费听", p.title);
        check("未判定为上限", p.isLimit === false);
        check("有「领取奖励」", p.enter !== null);
        check("有「坚持退出」", p.exit !== null);
    }
}

console.log("\n=== 06 广告倒计时 14s（连播第二支）===");
{
    const { api } = loadIndex(F("06-ad-countdown-14s.xml"), { w: 1220, h: 2656, act: "com.ss.android.excitingvideo.ExcitingVideoActivity" });
    const cd = api.findCountdown();
    check("识别到倒计时", cd !== null);
    if (cd) check("秒数=14", cd.sec === 14, String(cd.sec));
}

console.log("\n=== 07 直播间广告（关闭态，含更多面板）===");
{
    const { api } = loadIndex(F("07-ad-livedemo-closed.xml"), { w: 1220, h: 2656, act: "com.ss.android.excitingvideo.ExcitingVideoActivity" });
    const cl = api.findAdClosers();
    check("识别到关闭按钮", cl.length > 0, String(cl.length));
    check("没把「更多面板」当关闭", !cl.some((x) => /更多面板/.test(x.s)));
}

console.log("\n=== 09 奖励弹窗：明日免费听（今日已满）★关键 ===");
{
    const { api } = loadIndex(F("09-popup-MINGRI-limit.xml"), { w: 1220, h: 2656, act: "com.ss.android.excitingvideo.ExcitingVideoActivity" });
    const p = api.findRewardPopup();
    check("识别到奖励弹窗", p !== null);
    if (p) {
        check("标题=明日免费听", p.title === "明日免费听", p.title);
        check("★判定为今日已满", p.isLimit === true, "isLimit=" + p.isLimit);
    }
}

console.log("\n=== 22 奖励弹窗：按钮文案是「领取成功」而非「领取奖励」★关键 ===");
{
    // 用户实测：同一个位置有时显示「领取奖励」，有时显示「领取成功」
    const { api } = loadIndex(F("22-popup-claim-success.xml"), { w: 1220, h: 2656, act: "com.ss.android.excitingvideo.ExcitingVideoActivity" });

    const p = api.findRewardPopup();
    check("识别到奖励弹窗", p !== null);
    if (p) {
        check("标题=第17日免费听", p.title === "第17日免费听", p.title);
        check("能拿到领取按钮节点", p.enter !== null);
        check("★文案被记录为「领取成功」", p.label === "领取成功", p.label);
        check("有「坚持退出」", p.exit !== null);
    }

    // ★ 最容易踩的坑：顶栏 X 的 desc 是「领取成功，关闭，按钮」，
    //   大范围 descContains 会把 X 当成领奖励，一点就提前关掉广告栏。
    const claim = api.findPopupClaimNode();
    check("弹窗领取按钮被正确识别", claim !== null && claim.label === "领取成功",
        claim ? claim.label : "null");
    if (claim) {
        const b = claim.node.bounds();
        check("★没把顶栏 X 当成领取按钮", b.top > 2656 * 0.15, "top=" + b.top);
        check("落在弹窗按钮位置(514~706)", b.left === 514 && b.right === 706,
            b.left + "~" + b.right);
    }
    const x = api.adBarX();
    check("★顶栏 X 能单独识别出来", x !== null);
    if (x) {
        const xb = x.bounds();
        check("顶栏 X 在屏幕顶部 15% 内", xb.top < 2656 * 0.15, "top=" + xb.top);
        check("顶栏 X 的 desc 含「关闭」", /关闭/.test(x.desc()), x.desc());
    }
    // 关广告时仍然应该关顶栏那个 X，而不是弹窗按钮
    const cl = api.findAdClosers();
    check("关闭按钮列表非空", cl.length > 0, String(cl.length));
}

// ---------- 跨设备比例检查 ----------
console.log("\n=== 跨设备：X 关闭点是否随屏幕变化 ===");
{
    const sizes = [[1220, 2656], [1080, 2400], [1440, 3200], [1284, 2772], [720, 1600]];
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    check("脚本里没有硬编码 1220/2656 等像素", !/\b(1220|2656|1114|1135)\b/.test(
        src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    ), "发现硬编码像素");
}

console.log("\n========================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
console.log("========================================");
process.exit(fail === 0 ? 0 : 1);
