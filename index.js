/**
 * 汽水音乐 · 自动刷广告领畅听时长（Hamibot / Android）
 * ---------------------------------------------------------------
 * 目标：自动 打开App → 我的 → 更多 → 领取 → 看广告 → 关广告 → 领奖励 → 循环
 *      直到「今天的奖励次数达到上限」（弹窗标题变成「明日免费听」）为止。
 *
 * 设计原则（换手机也不失效）：
 *   1. 所有可交互元素【优先用 content-desc / text / resource-id 语义定位】，
 *      完全不写死像素坐标。
 *   2. 只有在「更多」图标这种没有任何文字的地方，才用【屏幕比例】兜底，
 *      比例基于 device.width / device.height 实时计算。
 *   3. 每个状态都做「点击后是否真的变化」校验，防止像旧脚本那样
 *      点不动一直空转。
 *   4. 任何异常都能自愈：回我的页 → 重开抽屉 → 重新领取。
 *
 * 设备：任意 Android 手机（已实测 1220x2656 / 520dpi）
 * 工具：Hamibot
 */

// ============================ 配置 ============================
var CFG = {
    PKG: "com.luna.music",              // 汽水音乐包名
    AD_ACT_HINT: "ExcitingVideoActivity", // 广告 Activity 关键字（仅用于日志）

    MAX_ADS: 80,                        // 单次运行最多看多少支广告（保险丝）
    MAX_MINUTES: 150,                   // 单次运行最长分钟数（保险丝）

    AD_WAIT_MAX_MS: 65000,              // 单支广告最长等待（含倒计时）
    AD_COUNTDOWN_SLICE: 5000,           // 倒计时每片等待时间
    CLOSE_RETRY: 6,                     // 单支广告关闭尝试次数

    LOOP_SLEEP: [1200, 2200],           // 每步之间的随机停顿
    DEBUG: true                         // true = 输出详细状态
};

// ========================= 基础工具 =========================
var W = device.width;
var H = device.height;

function now() { return Date.now(); }

function rnd(a, b) { return random(a, b); }

function nap(a, b) {
    if (b === undefined) { sleep(a); return; }
    sleep(rnd(a, b));
}

function D(msg) { if (CFG.DEBUG) log(msg); }

/** 屏幕比例坐标 */
function rx(v) { return Math.round(W * v); }
function ry(v) { return Math.round(H * v); }

/** 点击屏幕比例位置 */
function tapRatio(xr, yr) {
    return click(rx(xr), ry(yr));
}

/** 在超时内反复尝试 findOnce */
function tryFind(selector, timeout) {
    var end = now() + (timeout || 0);
    do {
        var n = selector.findOnce();
        if (n) return n;
        if (now() >= end) return null;
        sleep(120);
    } while (true);
}

/** 依次尝试多个选择器，返回第一个命中的节点 */
function tryFindAny(selectors, timeoutEach) {
    for (var i = 0; i < selectors.length; i++) {
        var n = tryFind(selectors[i], timeoutEach || 0);
        if (n) return n;
    }
    return null;
}

/** 点击一个 UiObject：节点可点 → 直接点；否则点祖先可点；最后点中心 */
function tapNode(node) {
    if (!node) return false;
    try { if (node.clickable && node.clickable()) { if (node.click()) return true; } } catch (e) { }
    try {
        var p = node.parent();
        for (var i = 0; p && i < 6; i++) {
            if (p.clickable && p.clickable()) { if (p.click()) return true; }
            p = p.parent();
        }
    } catch (e) { }
    try {
        var b = node.bounds();
        return click(b.centerX(), b.centerY());
    } catch (e) { }
    return false;
}

/**
 * 在节点范围内换个位置点（第 n 次重试时用）。
 * 有些弹窗按钮被透明浮层挡住，点正中心没反应，
 * 换到偏左/偏右/偏上/偏下往往就能命中。
 */
function tapPercent(node, n) {
    if (!node) return false;
    var b;
    try { b = node.bounds(); } catch (e) { return false; }
    var cx = b.centerX(), cy = b.centerY();
    var w = b.width(), h = b.height();
    var offsets = [
        [0, 0],
        [-0.28, 0], [0.28, 0],
        [0, -0.22], [0, 0.22],
        [-0.28, -0.22], [0.28, 0.22]
    ];
    var o = offsets[Math.min(n, offsets.length) - 1] || [0, 0];
    var x = Math.round(cx + w * o[0]);
    var y = Math.round(cy + h * o[1]);
    // 保证不越界
    x = Math.max(1, Math.min(W - 1, x));
    y = Math.max(1, Math.min(H - 1, y));
    D("    [重试] 换位置点击 " + x + "," + y + " (第" + n + "次)");
    return click(x, y);
}

/** 当前前台包名 / Activity */
function curPkg() {
    try { return currentPackage(); } catch (e) { return ""; }
}
function curAct() {
    try { return currentActivity(); } catch (e) { return ""; }
}

// ====================== 弹窗 / 干扰处理 ======================
/** 常见系统与 App 干扰弹窗的「放行」按钮文案 */
var DISMISS_WORDS = [
    "允许", "始终允许", "仅在使用中允许", "同意", "同意并继续", "我知道了",
    "知道了", "以后再说", "暂不更新", "取消", "关闭", "暂不", "跳过", "稍后",
    "拒绝", "不再提示", "下次再说"
];

/**
 * 处理权限弹窗、升级弹窗、隐私协议等。
 * 只在前台不是 com.luna.music 的「正常界面」时才动，
 * 避免误点汽水音乐自己的按钮。
 */
function dismissInterruptions() {
    var pk = curPkg();
    // 系统弹窗（权限/安装/输入法），包名往往不是汽水音乐
    if (pk && pk !== CFG.PKG) {
        for (var i = 0; i < DISMISS_WORDS.length; i++) {
            var n = text(DISMISS_WORDS[i]).findOnce();
            if (n) {
                D("  [干扰] 系统弹窗，点：" + DISMISS_WORDS[i] + " (" + pk + ")");
                tapNode(n);
                nap(700, 1100);
                return true;
            }
        }
        return false;
    }
    // 汽水音乐自己的弹窗：只处理明确表示"中断"的
    var ups = ["以后再说", "暂不更新", "暂不", "下次再说", "我知道了", "知道了"];
    for (var j = 0; j < ups.length; j++) {
        var m = text(ups[j]).findOnce();
        if (m) {
            D("  [干扰] App 弹窗，点：" + ups[j]);
            tapNode(m);
            nap(600, 1000);
            return true;
        }
    }
    return false;
}

// ====================== 楼层识别（我的页 / 抽屉）======================
/** 抽屉是否打开：用多个锚点文字判断，适配不同版本/不同屏幕 */
function isDrawerOpen() {
    var anchors = ["定时关闭", "音质音效", "清理缓存", "隐私与权限", "扫一扫", "音乐人中心"];
    var hit = 0;
    for (var i = 0; i < anchors.length; i++) {
        if (textContains(anchors[i]).findOnce()) hit++;
        if (hit >= 2) return true;
    }
    return false;
}

/** 点击底部「我的」标签（优先用语义 resource-id，其次用最靠底的文字节点） */
function tapMyTab() {
    var t = tryFind(id("navigation_tab_me"), 800);
    if (t) { D("  [我的] 用 resource-id 命中"); return tapNode(t); }

    var arr = text("我的").find();
    var best = null;
    for (var i = 0; i < arr.length; i++) {
        try {
            var b = arr[i].bounds();
            // 底部标签栏在屏幕最下方 15%
            if (b.centerY() > H * 0.85) {
                if (!best) best = arr[i];
            }
        } catch (e) { }
    }
    if (best) { D("  [我的] 用底部文字命中"); return tapNode(best); }
    return false;
}

/**
 * 找「更多」入口。
 * 这个图标是字体图标 \ue8a8，没有文字。
 * ★ 关键：播放页右上角有金币(\ue63d)/搜索图标，位置条件一模一样，
 *   点错就会跑去搜索页。所以优先用【字形】精确识别，
 *   只有拿不到字形时才退到位置判断。
 */
var MORE_GLYPH = "\ue8a8";       // "我的"页右上角的"更多"
var SEARCH_GLYPH = "\ue63d";     // 播放页右上角的搜索，必须排除

function findMoreButton() {
    var cands = [];

    // ---- 方案 1：字形精确匹配（最可靠，与屏幕尺寸无关）----
    try {
        var g = text(MORE_GLYPH).find();
        for (var i = 0; i < g.length; i++) {
            try {
                var gb = g[i].bounds();
                if (gb.width() > 0 && gb.top < H * 0.20) {
                    cands.push({ n: g[i], right: gb.right, by: "glyph" });
                }
            } catch (e) { }
        }
    } catch (e) { }

    // ---- 方案 2：位置兜底（仅限"我的"页）----
    // ★ 播放页右上角是搜索图标(\ue63d)，位置条件和"更多"一模一样，
    //   所以位置兜底必须限定在"我的"页，否则会跑去搜索页。
    if (cands.length === 0 && isMyPage()) {
        try {
            var all = classNameMatches(/android\.widget\.(FrameLayout|LinearLayout|ViewGroup)/)
                .clickable(true).find();
            for (var j = 0; j < all.length; j++) {
                try {
                    var b = all[j].bounds();
                    if (b.top >= H * 0.15) continue;
                    if (b.right < W * 0.78) continue;
                    if (!(b.width() > 0 && b.width() < W * 0.22)) continue;
                    if (!(b.height() > 0 && b.height() < H * 0.07)) continue;
                    // 排除已知的搜索/金币图标字形
                    var it = "";
                    try { it = all[j].text() || ""; } catch (e) { }
                    if (it === SEARCH_GLYPH) continue;
                    cands.push({ n: all[j], right: b.right, by: "pos" });
                } catch (e) { }
            }
        } catch (e) { }
    }

    if (cands.length === 0) return null;
    cands.sort(function (a, b) { return b.right - a.right; });
    D("  [更多] 候选 " + cands.length + " 个（" + cands[0].by + "），取最右");
    return cands[0].n;
}

/** 打开「更多」抽屉，成功返回 true（每一步都验证真的打开了） */
function openDrawer() {
    if (isDrawerOpen()) return true;

    // ---- 1. 字形/位置定位 ----
    var more = findMoreButton();
    if (more) {
        tapNode(more);
        nap(1000, 1500);
        if (isDrawerOpen()) { D("  [更多] 定位点击成功"); return true; }
        D("  [更多] 点了但没打开，换方案");
    }

    // ---- 2. 点字形节点的父级热区（图标不可点时常见）----
    try {
        var gf = text(MORE_GLYPH).findOnce();
        if (gf) {
            var p = gf.parent();
            for (var k = 0; p && k < 4; k++) {
                if (p.clickable && p.clickable()) {
                    var pb = p.bounds();
                    click(pb.centerX(), pb.centerY());
                    nap(1000, 1400);
                    if (isDrawerOpen()) { D("  [更多] 父节点热区成功"); return true; }
                    break;
                }
                p = p.parent();
            }
        }
    } catch (e) { }

    // ---- 3. 比例兜底（相对屏幕，不写死像素）----
    var fallbacks = [[0.930, 0.083], [0.950, 0.075], [0.905, 0.090], [0.960, 0.085]];
    for (var i = 0; i < fallbacks.length; i++) {
        D("  [更多] 比例兜底 " + fallbacks[i][0] + "," + fallbacks[i][1]);
        tapRatio(fallbacks[i][0], fallbacks[i][1]);
        nap(1000, 1400);
        if (isDrawerOpen()) return true;
    }
    return false;
}

/** 抽屉里的「领取」按钮文案（不同账号/阶段不同） */
var CLAIM_TEXTS = ["领时长", "继续领", "领取", "立即领取", "去领取", "领取奖励", "领"];

/** 在抽屉中找领取按钮 */
function findClaimButton() {
    for (var i = 0; i < CLAIM_TEXTS.length; i++) {
        var n = tryFind(text(CLAIM_TEXTS[i]), 0);
        if (n) {
            try {
                var b = n.bounds();
                // 排除底部导航「我的」等无关项：领取按钮在上半屏偏右
                if (b.width() > 0 && b.width() < W * 0.6) {
                    D("  [领取] 命中文案：" + CLAIM_TEXTS[i]);
                    return n;
                }
            } catch (e) { }
        }
    }
    // 模糊兜底：包含"领"字、且在抽屉 VIP 卡片区域（右侧、15%~30% 高度）
    var arr = textContains("领").find();
    for (var j = 0; j < arr.length; j++) {
        try {
            var bb = arr[j].bounds();
            var t = arr[j].text() || "";
            if (bb.centerX() > W * 0.60 &&
                bb.centerY() > H * 0.15 && bb.centerY() < H * 0.32 &&
                t.length <= 6) {
                D("  [领取] 模糊命中：" + t);
                return arr[j];
            }
        } catch (e) { }
    }
    return null;
}

/** 抽屉里是否显示「已领取」/已达上限 */
function drawerShowsClaimed() {
    if (textContains("已领取").findOnce()) return true;
    if (textContains("今日畅听").findOnce() && textContains("明日畅听").findOnce()) return true;
    return false;
}

// ====================== 广告页识别 ======================
/**
 * 找倒计时节点：content-desc 形如 "15秒后可领取奖励，关闭，按钮"
 * 返回 {node, sec}
 */
function findCountdown() {
    var n = tryFind(descMatches(/.*秒后可领取奖励.*/), 0);
    if (!n) n = tryFind(textMatches(/.*秒后可领取奖励.*/), 0);
    if (!n) return null;
    var s = "";
    try { s = n.desc() || n.text() || ""; } catch (e) { }
    var m = s.match(/(\d+)\s*秒/);
    return { node: n, sec: m ? parseInt(m[1], 10) : 0 };
}

/**
 * 是否在广告页（有广告栏特征）。
 * 只有确认在广告页，才允许把"关闭"类元素当成广告关闭按钮，
 * 否则会把抽屉里的「清理缓存 >」之类误判成关闭（实测踩过）。
 */
function inAdPage() {
    if (/ExcitingVideo/i.test(curAct())) return true;
    // ★ 直播间广告是另一个 Activity，实测出现过
    if (/LivePlayer|LiveActivity|live\.plugin/i.test(curAct())) return true;
    // 没有 Activity 信息时，用广告栏特征兜底
    if (tryFind(descContains("反馈"), 0)) return true;
    if (tryFind(descMatches(/.*秒后可领取奖励.*/), 0)) return true;
    if (tryFind(desc("广告"), 0)) return true;
    return false;
}

/**
 * 是否停留在「广告相关」页面（含直播间）。
 * 统一入口，避免各处正则漏掉直播间。
 */
function onAdActivity() {
    var a = curAct() || "";
    // ★ StubTranslucentActivity 是直播间广告的外壳（实测），必须算广告页，
    //   否则会被当成"已回到主界面"而提前结束广告阶段。
    return /ExcitingVideo|LivePlayer|live\.plugin|LunaSmoothLive|StubTranslucent/i.test(a);
}

/**
 * 是否在直播间广告里。
 *
 * 实测有两种形态，都要覆盖：
 *  A) StubTranslucent / LunaSmoothLive 且【有节点】——正片形态，
 *     里面有可点的 `关闭` Button 和「更多直播」文本；
 *  B) 同样 Activity 但【节点为 0】——SurfaceView 渲染时读不到东西。
 *
 * 注意不能只看"读不到内容"：有节点的直播间同样必须识别出来。
 */
function inLiveRoom() {
    var a = curAct() || "";

    // 明确的直播间 Activity → 直接认定
    if (/LivePlayer|live\.plugin|LunaSmoothLive/i.test(a)) return true;

    // StubTranslucent：可能是直播间，也可能是别的透明壳，继续用内容特征判断
    if (/StubTranslucent/i.test(a)) {
        // 有「更多直播 / 直播间」这类文案 → 就是直播间
        if (tryFind(textContains("更多直播"), 0)) return true;
        if (tryFind(textContains("直播间"), 0)) return true;
        // 完全读不到内容 → 也当直播间处理（盲关）
        if (!hasReadableContent()) return true;
        // 有内容但既不是激励视频栏、也不是弹窗 → 仍按直播间处理
        if (!tryFind(descContains("反馈"), 0) &&
            !tryFind(descContains("领取成功"), 0) &&
            !tryFind(desc("广告"), 0)) {
            return true;
        }
        return false;
    }

    // 其它 Activity：只有完全读不到内容时才猜测是直播间
    if (tryFind(descContains("反馈"), 0)) return false;
    if (tryFind(desc("广告"), 0)) return false;
    if (tryFind(descMatches(/.*秒后可领取奖励.*/), 0)) return false;
    if (tryFind(descContains("领取成功"), 0)) return false;
    if (hasReadableContent()) return false;
    return /ExcitingVideo/i.test(a);
}

/** 页面上是否存在任何「非空」的文字/描述节点 */
function hasReadableContent() {
    var nodes = [];
    try { nodes = classNameMatches(/.*/).find(); } catch (e) { nodes = []; }
    for (var i = 0; i < nodes.length; i++) {
        var d = "", t = "";
        try { d = nodes[i].desc() || ""; } catch (e) { }
        try { t = nodes[i].text() || ""; } catch (e) { }
        if (d.length > 0 || t.length > 0) return true;
    }
    return false;
}

/** 直播间/挽留页的退出流程（三层挽留，逐层点掉） */
function exitLiveRoom() {
    var mc = [
        "退出不看了", "退出", "不看了", "狠心离开", "再看看", "关闭"
    ];
    for (var pass = 0; pass < 4; pass++) {
        var hit = false;
        for (var i = 0; i < mc.length; i++) {
            var n = tryFind(textContains(mc[i]), 0);
            if (n) {
                D("    [直播退出] 点「" + mc[i] + "」");
                try { tapNode(n); } catch (e) { }
                hit = true;
                nap(1200, 1600);
                break;
            }
        }
        if (!hit) break;
        // 已经不在直播间了就收工
        if (!inLiveRoom()) return true;
    }
    return !inLiveRoom();
}

/**
 * 直播间盲关：取不到节点时，按比例点右上角 X。
 * 比例 (0.943, 0.084) 是实测主播间 X 的位置，
 * 用多个候选值提高容错。
 */
/**
 * 关闭直播间。
 * 优先用真实节点（正片形态下 `关闭` Button 是可点的），
 * 拿不到节点时才退到比例盲点。
 */
function blindCloseLive() {
    // ① 优先：找真实的「关闭」按钮节点（实测 Button[1090,176][1207,293] 可点）
    var closers = [];
    try { closers = desc("关闭").find(); } catch (e) { closers = []; }
    for (var c = 0; c < closers.length; c++) {
        var nb = null;
        try { nb = closers[c].bounds(); } catch (e) { }
        if (!nb || nb.top > H * 0.15) continue;   // 关闭按钮都在顶部
        if (closers[c].clickable && closers[c].clickable()) {
            D("    [直播关闭] 命中可点「关闭」节点 " + nb.centerX() + "," + nb.centerY());
            try { closers[c].click(); } catch (e) { }
        } else {
            D("    [直播关闭] 点「关闭」节点坐标 " + nb.centerX() + "," + nb.centerY());
            click(nb.centerX(), nb.centerY());
        }
        nap(1400, 1900);
        if (tryFind(textContains("退出不看了"), 0)) { exitLiveRoom(); nap(1000, 1400); }
        if (!inLiveRoom()) return true;
    }

    // ② 兜底：比例盲点
    var pts = [[0.943, 0.084], [0.930, 0.083], [0.950, 0.080], [0.915, 0.088]];
    for (var i = 0; i < pts.length; i++) {
        D("    [直播盲关] 点 " + pts[i][0] + "," + pts[i][1]);
        tapRatio(pts[i][0], pts[i][1]);
        nap(1400, 1900);
        // 出现了挽留页就把它点掉
        if (tryFind(textContains("退出不看了"), 0)) {
            exitLiveRoom();
            nap(1000, 1400);
        }
        if (!inLiveRoom()) return true;
    }
    return false;
}

/**
 * 找广告的关闭按钮。
 * 注意：真正的 X 图标是容器里的一个小 ImageView，
 * 点文字节点中心会点不动（旧脚本就是死在这里）。
 * 这里把「X 图标的真实坐标」算出来。
 */
function findAdClosers() {
    var out = [];
    // 不在广告页就不返回任何东西
    if (!inAdPage()) return out;
    var sels = [
        descContains("领取成功"),
        descContains("关闭"),
        textContains("关闭"),
        descContains("跳过"),
        textContains("跳过")
    ];
    var seen = {};
    for (var i = 0; i < sels.length; i++) {
        var arr = [];
        try { arr = sels[i].find(); } catch (e) { arr = []; }
        for (var j = 0; j < arr.length; j++) {
            var n = arr[j];
            var s = "";
            try { s = (n.desc() || "") + "|" + (n.text() || ""); } catch (e) { }
            // 还在倒计时的"关闭"不算，必须等可领取
            if (/秒后可领取/.test(s)) continue;
            var b;
            try { b = n.bounds(); } catch (e) { continue; }
            // 广告的关闭/跳过只在顶部栏（屏高 15% 内），其余一律不认
            if (b.top > H * 0.15) continue;
            if (b.width() <= 0 || b.height() <= 0) continue;
            var key = b.left + "," + b.top + "," + b.right + "," + b.bottom;
            if (seen[key]) continue;
            seen[key] = 1;
            out.push({ node: n, b: b, s: s });
        }
    }
    // 顶部优先（广告栏的 X 都在顶部 15% 以内）
    out.sort(function (a, b) { return a.b.top - b.b.top; });
    return out;
}

/** 计算关闭按钮的真实点击点，返回 [x, y] */
function closeTapPoint(item) {
    var b = item.b;
    var node = item.node;
    // 1) 节点内部右侧的 ImageView（最常见的 X 图标）
    try {
        var cc = node.childCount();
        for (var i = 0; i < cc; i++) {
            var c = node.child(i);
            if (!c) continue;
            var cn = "";
            try { cn = c.className() || ""; } catch (e) { }
            if (/ImageView/.test(cn)) {
                var cb = c.bounds();
                if (cb.width() > 0 && cb.centerX() > b.centerX()) {
                    D("    [X] 用子 ImageView: " + cb.centerX() + "," + cb.centerY());
                    return [cb.centerX(), cb.centerY()];
                }
            }
        }
    } catch (e) { }
    // 2) 父容器里的兄弟 ImageView
    try {
        var p = node.parent();
        if (p) {
            var pc = p.childCount();
            for (var j = 0; j < pc; j++) {
                var s = p.child(j);
                if (!s) continue;
                var sn = "";
                try { sn = s.className() || ""; } catch (e) { }
                if (!/ImageView/.test(sn)) continue;
                var sb = s.bounds();
                if (sb.width() > 0 &&
                    sb.centerY() >= b.top && sb.centerY() <= b.bottom &&
                    sb.centerX() > b.centerX()) {
                    D("    [X] 用兄弟 ImageView: " + sb.centerX() + "," + sb.centerY());
                    return [sb.centerX(), sb.centerY()];
                }
            }
        }
    } catch (e) { }
    // 3) 兜底：容器右侧内缩 4.5% 屏宽（X 图标永远贴在容器右端）
    var x = b.right - Math.round(W * 0.045);
    var y = b.centerY();
    D("    [X] 用右侧内缩兜底: " + x + "," + y);
    return [x, y];
}

// ====================== 奖励弹窗识别 ======================
/**
 * 奖励弹窗：
 *   「再看N个视频提前得」 + 标题（今日免费听 / 第6日免费听 / 明日免费听）
 *   + 「领取奖励」 + 「坚持退出」
 * 返回 null 或 {title, isLimit, enter, exit}
 */
function findRewardPopup() {
    var enter = tryFind(desc("领取奖励"), 0) || tryFind(text("领取奖励"), 0);
    var exit = tryFind(desc("坚持退出"), 0) || tryFind(text("坚持退出"), 0);
    if (!enter && !exit) return null;

    // 标题：今日免费听 / 明日免费听 / 第N日免费听 / 今日畅听 ...
    var title = "";
    var t1 = tryFind(descMatches(/^(今|明)日免费听$|^第\d+日免费听$/), 0);
    if (!t1) t1 = tryFind(textMatches(/^(今|明)日免费听$|^第\d+日免费听$/), 0);
    if (t1) {
        try { title = t1.desc() || t1.text() || ""; } catch (e) { }
    }
    if (!title) {
        // 兜底：在弹窗区域找含"免费听/畅听"的文字
        var arr = descMatches(/.*(免费听|畅听).*/).find();
        for (var i = 0; i < arr.length; i++) {
            var s = "";
            try { s = (arr[i].desc() || arr[i].text() || ""); } catch (e) { }
            if (/^第\d+日/.test(s) || /^(今|明)日/.test(s)) { title = s; break; }
        }
    }

    var isLimit = /^明日免费听$/.test(title) || /明天/.test(title);
    return { title: title, isLimit: isLimit, enter: enter, exit: exit, blind: false };
}

/**
 * ★★ 重大实测教训：奖励弹窗有时【完全读不到无障碍节点】。
 *   屏幕上明明显示「再看2个视频提前得 / 第13日免费听 / 领取奖励 / 坚持退出」，
 *   但无障碍树里一个都读不到（弹窗是自绘层），只剩顶部广告栏。
 *
 *   ⚠ 危险：直播广告落地页的节点签名和它【几乎完全一样】
 *     （都只有 "反馈，按钮" + "领取成功，关闭，按钮"）。
 *     如果在落地页上盲点 (0.5, 0.534)，会误触「点击进入直播间」，
 *     反被拖进直播间 —— 实测踩过这个坑。
 *
 *   所以盲点不能当"主动判断"，必须满足【卡住证据】才允许：
 *     连续多次点 X 都无效（广告栏一直在、界面没推进）。
 */
function findBlindPopup(stuckEvidence) {
    if (!onAdActivity()) return null;

    // 有正常的弹窗节点就不用盲点
    if (tryFind(desc("领取奖励"), 0) || tryFind(text("领取奖励"), 0)) return null;
    if (tryFind(desc("坚持退出"), 0) || tryFind(text("坚持退出"), 0)) return null;

    // 必须确实是广告页：有广告栏特征
    var barOk = false;
    if (tryFind(descContains("领取成功"), 0)) barOk = true;
    if (tryFind(descContains("反馈"), 0)) barOk = true;
    if (!barOk) return null;

    // 还有倒计时 → 真在放，不要乱点
    if (tryFind(descMatches(/.*秒后可领取奖励.*/), 0)) return null;

    // ★ 没有"卡住证据"就不盲点，避免在直播落地页上误触
    if (!stuckEvidence) return null;

    return { title: "(读不到)", isLimit: false, enter: null, exit: null, blind: true };
}

/** 盲点弹窗上的「领取奖励」（按屏宽/屏高比例，不写死像素） */
/**
 * 盲点弹窗上的「领取奖励」（按屏宽/屏高比例，不写死像素）。
 * 实测 1220×2656：红色按钮覆盖 y=1386~1528（高 142），中心 (610,1457)。
 * 取三个候选点覆盖按钮上下，任一中即成功。
 */
function blindTapClaim() {
    var pts = [
        [0.500, 0.534],   // (610, 1418) 实测点中即可推进
        [0.500, 0.549],   // (610, 1457) 按钮几何中心
        [0.500, 0.525],   // (610, 1394) 按钮上沿内侧
        [0.500, 0.565]    // (610, 1500) 按钮下沿内侧
    ];
    for (var i = 0; i < pts.length; i++) {
        D("    [盲点] 领取奖励 " + pts[i][0] + "," + pts[i][1]);
        tapRatio(pts[i][0], pts[i][1]);
        nap(1500, 2000);
        // 点完出现倒计时或弹窗节点 → 成功推进
        if (tryFind(descMatches(/.*秒后可领取奖励.*/), 0)) return true;
        if (tryFind(desc("领取奖励"), 0)) return true;
        // 界面已经离开广告页也算成功（可能直接跳下一个环节）
        if (!onAdActivity()) return true;
    }
    return false;
}

/** 盲点弹窗上的「坚持退出」 */
function blindTapExit() {
    var pts = [
        [0.500, 0.600],   // 实测约 (610,1594)
        [0.500, 0.612],
        [0.500, 0.588]
    ];
    for (var i = 0; i < pts.length; i++) {
        D("    [盲点] 坚持退出 " + pts[i][0] + "," + pts[i][1]);
        tapRatio(pts[i][0], pts[i][1]);
        nap(1500, 2000);
        if (!onAdActivity()) return true;
        if (!tryFind(descContains("领取成功"), 0)) return true;
    }
    return false;
}

/** 弹窗开头的「再看N个视频」文案，用于日志/节奏参考 */
function popupHint() {
    var n = tryFind(descMatches(/.*再看\d+个视频.*/), 0);
    if (!n) return "";
    try { return n.desc() || n.text() || ""; } catch (e) { return ""; }
}

// ====================== App 启动/归位 ======================
function launchAppSafe() {
    D("  [启动] 打开汽水音乐");
    try {
        app.launchPackage(CFG.PKG);
    } catch (e) {
        try { launchApp("汽水音乐"); } catch (e2) { }
    }
    nap(3500, 5000);
    // 开屏广告的"跳过"
    for (var i = 0; i < 6; i++) {
        var sk = tryFind(descMatches(/.*跳过.*/), 0) || tryFind(textMatches(/.*跳过.*/), 0);
        if (sk) { D("  [启动] 关开屏广告"); tapNode(sk); nap(800, 1200); }
        dismissInterruptions();
        if (curPkg() === CFG.PKG && !/Splash|splash|ad\./.test(curAct())) break;
        nap(600, 900);
    }
}

/**
 * 判断是否在「我的」页。
 * 特征：听歌总时长 / 好友听歌周榜 / 创建的歌单 + 底部「我的」被选中
 */
function isMyPage() {
    var hits = 0;
    if (textContains("听歌总时长").findOnce()) hits++;
    if (textContains("好友听歌周榜").findOnce()) hits++;
    if (textContains("创建的歌单").findOnce()) hits++;
    if (textContains("我喜欢的").findOnce()) hits++;
    return hits >= 2;
}

/**
 * 若误入播放页/搜索页/金币页，退回主界面。
 * 播放页特征：底部有播放按钮 + "模式选择" 之类。
 */
function escapeWrongPage() {
    var pk = curPkg();
    if (pk !== CFG.PKG) return false;
    if (onAdActivity()) return false; // 广告页单独处理

    // 搜索页特征
    if (textContains("搜索历史").findOnce() || textContains("猜你想搜").findOnce()) {
        D("  [纠偏] 误入搜索页，返回");
        back(); nap(800, 1200);
        return true;
    }
    // 金币/任务页特征
    if (textContains("金币").findOnce() && textContains("任务").findOnce()) {
        D("  [纠偏] 误入金币任务页，返回");
        back(); nap(800, 1200);
        return true;
    }
    return false;
}

/** 确保在「我的」页 + 抽屉已打开 */
function ensureDrawerReady() {
    for (var attempt = 0; attempt < 4; attempt++) {
        if (isDrawerOpen()) return true;

        if (curPkg() !== CFG.PKG) {
            launchAppSafe();
        }

        // 如果在广告页，先退出来
        if (onAdActivity()) {
            D("  [归位] 仍停在广告页，按返回退出（第 " + (attempt + 1) + " 次）");

            // ★ 实测：广告页里 back() 经常退不出去（连按 5 次仍停在原页）。
            //   如果屏幕上有"读不到节点"的奖励弹窗，先盲点「坚持退出」最有效。
            //   但盲点有风险（直播落地页会被误触），所以只在【已经失败过一次】后才用。
            var bp = findBlindPopup(attempt >= 1);
            if (bp) {
                D("  [归位] 疑似自绘奖励弹窗，盲点「坚持退出」");
                if (blindTapExit()) {
                    D("  [归位] 盲点退出成功");
                    nap(800, 1200);
                    continue;
                }
            }

            // 再试正常返回；多按几次
            for (var b = 0; b < 3 && onAdActivity(); b++) {
                try { back(); } catch (e) { }
                nap(900, 1300);
            }
            if (onAdActivity()) {
                // back 完全无效时，退一步用 HOME 键拉回桌面再重新进 App
                D("  [归位] back 无效，回桌面重开 App");
                try { home(); } catch (e) { }
                nap(1200, 1600);
                launchAppSafe();
            }
            continue;
        }

        // 误入搜索/金币等页面，纠偏
        if (escapeWrongPage()) continue;

        // 不在"我的"页才点标签（避免已经在该页又点一次导致刷新）
        if (!isMyPage()) {
            tapMyTab();
            nap(1000, 1500);
        }

        if (openDrawer()) return true;

        D("  [归位] 第 " + (attempt + 1) + " 次失败，重试");
        dismissInterruptions();
        nap(700, 1100);
    }
    return false;
}

// ====================== 广告主流程 ======================
/**
 * 跑完当前这一整个广告链（可能连播多支）。
 * 返回：
 *   'LIMIT'   今日已达上限（弹窗变明日免费听）
 *   'OK'      正常跑完，回到了主界面，可继续下一轮
 *   'NOAD'    点进去没广告（可能没次数了）
 *   'TIMEOUT' 超时
 */
function runAdPhase() {
    var t0 = now();
    var adsDone = 0;
    var lastSig = "";
    var stuck = 0;
    var popTries = 0;        // 同一弹窗连续点击次数
    var lastPopKey = "";
    var blindCount = 0;      // 读不到节点的弹窗，盲点次数
    var closeTries = 0;      // 同一关闭按钮连续点击次数（判断"卡住"的证据）

    while (now() - t0 < CFG.MAX_MINUTES * 60 * 1000) {
        // ---------- 1. 奖励弹窗 ----------
        var pop = findRewardPopup();

        // ★ 无障碍读不到弹窗时（自绘层），用比例盲点兜底。
        //   必须带上"卡住证据"：同一关闭按钮已经点了多次没反应。
        //   ⚠ 注意：证据来自【上一轮】，所以判定用的是"关闭次数"而不是位置顺序。
        if (!pop) {
            var blind = findBlindPopup(closeTries >= 2);
            if (blind) {
                blindCount++;
                log("  ★ 检测到「读不到节点」的奖励弹窗，盲点「领取奖励」（第 " + blindCount + " 次）");
                if (blindTapClaim()) {
                    log("    → 盲点成功，广告已开始");
                    blindCount = 0;
                    continue;
                }
                // 盲点几次还不行 → 试「坚持退出」脱身
                if (blindCount >= 3) {
                    log("  ⚠ 盲点领取无效，盲点「坚持退出」脱身");
                    blindTapExit();
                    blindCount = 0;
                    var stillAd = onAdActivity();
                    if (!stillAd) return "OK";
                    // 还在广告页就先退出广告链，让上层重新归位
                    return "NOAD";
                }
                continue;
            }
            blindCount = 0;
        }

        if (pop) {
            var hint = popupHint();
            // ★ 用「天数 + 明细」做弹窗身份。
            //   【不能】用 title+hint 整体，因为 hint 会随剩余次数变化
            //   （"再看2个"→"再看1个"），同一个卡住的弹窗会被当成新的。
            //   也不能只看天数：同一天可能真的要多看几支。
            //   折中：天数相同 + 提示也相同 才算"同一个弹窗没动"。
            var dayKey = (pop.title || "") + "|" + hint;
            if (dayKey === lastPopKey) {
                popTries++;
            } else {
                lastPopKey = dayKey;
                popTries = 1;
            }

            log("  ★ 奖励弹窗：" + (pop.title || "?") +
                (hint ? "（" + hint + "）" : "") +
                (popTries > 1 ? " [同状态第" + popTries + "次]" : ""));

            if (pop.isLimit) {
                log("  ✔ 今日奖励已达上限（出现「明日免费听」），收工");
                if (pop.exit) { try { tapNode(pop.exit); } catch (e) { } nap(1200, 1800); }
                return "LIMIT";
            }

            // ★ 同一天数 + 同样提示，连续 5 次都没变化 → 真的卡死了
            //   （实测正常推进时天数会变：第7日→第8日，所以不会误判）
            if (popTries > 5) {
                log("  ⚠ 同一状态点了 " + popTries + " 次无效，改用「坚持退出」脱离");
                if (pop.exit) {
                    try { tapNode(pop.exit); } catch (e) { }
                    nap(1500, 2000);
                    var popAfter = findRewardPopup();
                    if (!popAfter) return "OK";
                }
                log("  ⚠ 仍卡在弹窗，强制返回");
                try { back(); } catch (e) { }
                nap(1200, 1600);
                return "NOAD";
            }

            if (pop.enter) {
                // 前两次点中心；之后换位置试，防止被浮层挡住
                if (popTries <= 2) {
                    tapNode(pop.enter);
                } else {
                    tapPercent(pop.enter, popTries - 1);
                }
                log("    → 点「领取奖励」，继续下一个");
                nap(2200, 3200);
                continue;
            }
            if (pop.exit) {
                try { tapNode(pop.exit); } catch (e) { }
                nap(1200, 1800);
                continue;
            }
        } else {
            // 弹窗消失就清掉计数，避免下一轮误判
            if (lastPopKey !== "") { lastPopKey = ""; popTries = 0; }
        }

        // ---------- 2. 倒计时中：老实等 ----------
        var cd = findCountdown();
        if (cd) {
            var wait = Math.min(Math.max(cd.sec, 1) * 1000 + 800, CFG.AD_COUNTDOWN_SLICE);
            D("  ⏳ 倒计时 " + cd.sec + "s，等 " + Math.round(wait / 1000) + "s");
            sleep(wait);
            continue;
        }

        // ---------- 3. 广告可关了 ----------
        var closers = findAdClosers();
        if (closers.length > 0) {
            // 同一支广告反复关不掉也要能脱身
            var closeKey = closers[0].s.substring(0, 20) + "@" + closers[0].b.left + "," + closers[0].b.top;
            if (closeKey === lastSig) { stuck++; closeTries = stuck; } else { stuck = 0; lastSig = closeKey; closeTries = 0; }

            // ★★ 关键修复：点 X 连续无效，说明界面上【有读不到节点的弹窗挡着】。
            //    此时必须就地盲点「领取奖励」，而不是先去 back()。
            //    以前这里直接 back() + continue，导致盲点逻辑永远走不到（实测卡死）。
            if (stuck >= 2) {
                log("  ⚠ 关闭按钮点了 " + stuck + " 次无效 → 怀疑被自绘弹窗挡住");
                blindCount++;
                log("    盲点「领取奖励」（第 " + blindCount + " 次）");
                if (blindTapClaim()) {
                    log("    ✔ 盲点成功，广告开始播放");
                    stuck = 0; closeTries = 0; blindCount = 0;
                    continue;
                }
                if (blindCount >= 3) {
                    log("    ⚠ 盲点领取无效，盲点「坚持退出」脱身");
                    if (blindTapExit() || !onAdActivity()) {
                        log("    ✔ 已脱离广告页");
                        return "OK";
                    }
                    // 退不出来就回到上层，由 ensureDrawerReady 的重型兜底处理
                    return "NOAD";
                }
                continue;
            }

            if (stuck >= 6) {
                log("  ⚠ 关闭按钮点了 " + stuck + " 次仍无效，改用返回键");
                try { back(); } catch (e) { }
                nap(1200, 1600);
                adsDone++;
                stuck = 0; closeTries = 0;
                continue;
            }

            var item = closers[0];
            var pt = closeTapPoint(item);
            D("  ✕ 关广告：" + item.s.substring(0, 24) + " → " + pt[0] + "," + pt[1]);
            click(pt[0], pt[1]);
            adsDone++;
            nap(1800, 2600);
            continue;
        }

        // ---------- 4. 回到主界面了 ----------
        if (curPkg() === CFG.PKG && !onAdActivity()) {
            if (isDrawerOpen()) return adsDone > 0 ? "OK" : "NOAD";
            D("  ↩ 已回到主界面（本轮广告数 " + adsDone + "）");
            if (adsDone > 0) return "OK";
            // 可能广告被秒关，短暂等待有没有新广告
            nap(1500, 2200);
            if (onAdActivity()) continue;
            return "NOAD";
        }

        // ---------- 5. 直播间广告：取不到节点，只能盲关 ----------
        if (inLiveRoom()) {
            log("  📺 检测到直播间广告（无障碍无节点），盲关右上角");
            if (blindCloseLive()) {
                D("    已退出直播间");
                adsDone++;
                stuck = 0;
                nap(1500, 2000);
                continue;
            }
            // 关不掉就退一层重试
            stuck++;
            if (stuck >= 3) {
                log("  ⚠ 直播间关不掉，返回键脱离");
                try { back(); } catch (e) { }
                nap(1200, 1600);
                exitLiveRoom();
                stuck = 0;
            }
            continue;
        }

        // ---------- 6. 其它页面：处理干扰 / 退出 ----------
        if (dismissInterruptions()) { stuck = 0; continue; }

        var sig = curPkg() + "/" + curAct();
        if (sig === lastSig) stuck++; else { stuck = 0; lastSig = sig; }
        if (stuck >= 5) {
            D("  ⚠ 状态卡住，退出广告链");
            try { back(); } catch (e) { }
            nap(1000, 1400);
            return "TIMEOUT";
        }
        nap(1200, 1800);
    }
    D("  ⚠ 广告阶段超时");
    return "TIMEOUT";
}

// ========================== 主流程 ==========================
function main() {
    // ★ 无障碍服务可能被系统临时解绑（实测发生过），
    //   这里必须带重试，不能因为一次失败就整个脚本退出。
    var a11yOk = false;
    for (var i = 0; i < 6; i++) {
        try {
            auto.waitFor();
            a11yOk = true;
            break;
        } catch (e) {
            log("[启动] 等待无障碍服务... 第 " + (i + 1) + " 次");
            sleep(2000);
        }
    }
    if (!a11yOk) {
        // 最后再等一轮，仍失败也继续，让上层循环去处理
        try { auto.waitFor(); a11yOk = true; } catch (e2) { }
    }

    try { auto.setMode("fast"); } catch (e) { }
    try { console.show(); } catch (e) { }
    try { device.keepScreenOn(CFG.MAX_MINUTES * 60 * 1000); } catch (e) { }
    try { device.wakeUp(); } catch (e) { }

    log("========== 汽水音乐 · 自动领畅听 ==========");
    log("屏幕：" + W + " x " + H);
    log("包名：" + CFG.PKG);
    if (!a11yOk) log("⚠ 无障碍服务未就绪，仍尝试运行");

    var tStart = now();
    var ads = 0;
    var failStreak = 0;
    var result = "未完成";

    // ★ 起步：按要求自动打开 App → 我的 → 更多 → 领取
    try { launchAppSafe(); } catch (e) { log("[启动] launchAppSafe 异常：" + e); }

    // 如果 App 还停在播放页（有音乐在放），先暂停，避免节点一直刷新
    try {
        if (!isMyPage() && textContains("模式选择").findOnce()) {
            D("  [起步] 检测到播放页，先暂停播放");
            try { device.pressKeyCode(KeyCode.MEDIA_PAUSE); } catch (e) { }
            nap(600, 900);
        }
    } catch (e) { }

    // 走到「我的」页
    for (var boot = 0; boot < 4; boot++) {
        if (isDrawerOpen()) break;
        if (!isMyPage()) {
            tapMyTab();
            nap(1000, 1500);
        }
        if (isMyPage()) break;
        escapeWrongPage();
        nap(500, 800);
    }

    while (ads < CFG.MAX_ADS && (now() - tStart) < CFG.MAX_MINUTES * 60 * 1000) {
        log("---------- 第 " + (ads + 1) + " 轮 ----------");
        LIMIT_FLAG = false;

        // ★ 整轮都包在 try 里：无障碍服务抖动、节点瞬间失效、
        //   都会抛异常。以前没包，一抛异常脚本就静默退出，界面卡死不动。
        try {
            var advanced = runOneRound();
            if (LIMIT_FLAG) {
                result = "今日已达上限";
                log("  ✔ 判定今日已达上限，收工");
                break;
            }
            if (!advanced) {
                failStreak++;
                log("  ✗ 本轮未完成（连续 " + failStreak + "）");
                if (failStreak >= 5) { result = "多次无法推进"; break; }
                try { back(); } catch (eB) { }
                nap(1200, 1800);
                continue;
            }
            ads++;
            failStreak = 0;
            log("  ✔ 累计完成 " + ads + " 支广告");
        } catch (e) {
            failStreak++;
            log("  ✗ 本轮异常：" + e);
            if (failStreak >= 5) { result = "异常过多：" + e; break; }
            try { back(); } catch (eB2) { }
            sleep(1500);
        }
        nap(CFG.LOOP_SLEEP[0], CFG.LOOP_SLEEP[1]);
    }

    log("========== 结束 ==========");
    log("结果：" + result);
    log("完成广告：" + ads + " 支");
    log("耗时：" + Math.round((now() - tStart) / 60000) + " 分钟");
    try { toast("汽水音乐任务结束：" + result + "（" + ads + " 支）"); } catch (e) { }
}

// ========================== 单轮 ==========================
/**
 * 跑一轮：归位 → 找领取 → 点 → 处理广告链。
 * 返回 true  = 正常完成一轮（或已判定上限，用 LIMIT_FLAG 标记）
 * 返回 false = 本轮没推进
 */
var LIMIT_FLAG = false;

function runOneRound() {
    // 1) 归位：我的页 + 抽屉
    if (!ensureDrawerReady()) {
        log("  ✗ 无法打开「更多」抽屉");
        try { tapRatio(0.5, 0.5); } catch (e) { }
        return false;
    }

    // 2) 找领取按钮
    var claim = findClaimButton();
    if (!claim) {
        if (drawerShowsClaimed()) {
            log("  ✔ 抽屉显示「已领取」，今日已完成");
            LIMIT_FLAG = true;
            return true;
        }
        log("  ✗ 没找到领取按钮");
        return false;
    }

    // 3) 记录按钮文案，点它
    var label = "";
    try { label = claim.text() || ""; } catch (e) { }
    log("  点「" + label + "」进入广告");
    tapNode(claim);
    nap(2600, 3600);

    // 4) 广告阶段
    var r = runAdPhase();
    log("  广告阶段结果：" + r);

    if (r === "LIMIT") { LIMIT_FLAG = true; return true; }
    if (r === "OK") return true;

    // 没刷成，退回到主界面
    try {
        if (!(curPkg() === CFG.PKG && !onAdActivity())) {
            back(); nap(900, 1300);
        }
    } catch (e) { }
    return false;
}

main();
