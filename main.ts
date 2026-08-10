import { Plugin, ItemView, Modal, Notice, Menu, TFile, TAbstractFile, TFolder, PluginSettingTab, Setting, App, WorkspaceLeaf, setIcon } from 'obsidian';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

// 类型定义
interface AccountingConfig {
    appName: string;
    categories: Record<string, string>;
    expenseEmoji: string;
    journalsPath: string;
    dateFormat: string; // 日记文件日期命名格式，默认 yyyy-MM-dd
    defaultCategory?: string; // 默认分类关键词
    enableQuickCopy?: boolean; // 启用快速记账功能
    quickCopyDays?: number; // 快速记账显示最近N天的记录
    billMerchantMap?: Record<string, { category: string; description?: string }>; // 账单商户关键字 → { 分类关键词, 描述 } 映射（用于bill.md自动分类）
    silentBillImport?: boolean; // 静默记账：识别成功后不弹窗，直接写入日记
    showMainPageStats?: boolean; // 在主页面显示简化支出统计表格（默认隐藏）
    budgets?: {
        monthly: {
            total: number;
            categories: Record<string, number>;
        };
        enableAlerts: boolean;
        alertThreshold: number;
    };
    reclassifyRules?: ReclassifyConfig; // 批量重分类规则
}

interface AccountingRecord {
    date: string;
    fileDate: string;
    keyword: string;
    category: string;
    amount: number;
    isIncome: boolean;
    description: string;
    rawLine: string;
    isBackfill: boolean;
}

interface AccountingStats {
    totalIncome: number;
    totalExpense: number;
    categoryStats: Record<string, {
        total: number;
        count: number;
        records: AccountingRecord[];
    }>;
    dailyStats: Record<string, {
        income: number;
        expense: number;
        records: AccountingRecord[];
    }>;
    budgetStatus: BudgetStatus | null;
}

interface BudgetStatus {
    totalBudget: number;
    totalSpent: number;
    totalRemaining: number;
    totalProgress: number;
    categories: Record<string, {
        budget: number;
        spent: number;
        remaining: number;
        progress: number;
        keyword: string;
    }>;
    alerts: Array<{
        type: 'warning' | 'exceeded';
        category: string;
        message: string;
    }>;
}

interface DateRangeModalOptions {
    onSelect: (start: string, end: string) => void;
}

interface InternalPlugins {
    plugins?: Record<string, { enabled: boolean; instance: SearchPluginInstance }>;
}

interface SearchPluginInstance {
    searchEngine?: {
        searchText?: (term: string, options: { path: string }) => Promise<SearchResult[]>;
        search?: (term: string) => Promise<SearchResult[]>;
    };
}

interface SearchResult {
    file?: TFile;
    path?: string;
}

// ── 批量重分类类型定义 ─────────────────────────────────────────────────────────

/** 单条重分类规则 */
interface ReclassifyRule {
    keyword: string;       // 备注关键词（必填，大小写不敏感匹配）
    fromCategory: string;  // 源分类关键词，空字符串表示「不限」
    toCategory: string;    // 目标分类关键词（必填）
    autoApply?: boolean;   // 打开记账页面时自动执行此规则
    rewriteDescription?: string; // 重写备注（非空时替换原备注）
}

/** 持久化配置，存入 config.json 的 reclassifyRules 字段 */
type ReclassifyConfig = ReclassifyRule[];

/** 单条预览结果 */
interface ReclassifyMatch {
    rule: ReclassifyRule;         // 匹配到该记录的规则
    record: AccountingRecord;     // 原始记录
    newRawLine: string;           // 替换后的新行文本
    filePath: string;             // 所在日记文件路径（journalsPath/YYYY-MM-DD.md）
}

/** 预览结果汇总 */
interface PreviewResult {
    matches: ReclassifyMatch[];
    totalCount: number;
    fileCount: number;            // 涉及的不同文件数
}

/** 规则校验错误 */
interface ValidationError {
    ruleIndex: number;            // 从 1 开始
    message: string;
}

/** 批量改分类单条匹配 */
interface BatchCategoryMatch {
    record: AccountingRecord;
    toCategory: string;
    newRawLine: string;
    filePath: string;
}

/** 批量改分类预览结果 */
interface BatchCategoryPreview {
    matches: BatchCategoryMatch[];
    totalCount: number;
    fileCount: number;
}

type BatchTimeRange = 'all' | 'thisMonth' | 'lastMonth' | 'last6Months';

// 视图类型常量
const RECLASSIFY_VIEW = 'coin-memo-reclassify';

type CategoryStatEntry = AccountingStats['categoryStats'][string];
type MerchantMapEntry = { category: string; description?: string };

/** 两位数补零（避免 padStart 在 ES6 lib 下的 unsafe 告警） */
function pad2(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}

/** 类型安全的 Object.entries */
function recordEntries<K extends string, V>(record: Record<K, V>): Array<[K, V]> {
    return Object.entries(record) as Array<[K, V]>;
}

function categoryStatEntries(stats: Record<string, CategoryStatEntry>): Array<[string, CategoryStatEntry]> {
    return recordEntries(stats);
}

// 辅助函数：格式化本地日期为 YYYY-MM-DD（避免 UTC 时区问题）
function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    return `${year}-${month}-${day}`;
}

function buildExportFileName(appName: string, startDate: string, endDate: string): string {
    const monthStart = /^(\d{4})-(\d{2})-01$/.exec(startDate);
    if (monthStart) {
        const year = Number(monthStart[1]);
        const month = Number(monthStart[2]);
        const lastDay = new Date(year, month, 0).getDate();
        const fullMonthEnd = `${monthStart[1]}-${monthStart[2]}-${pad2(lastDay)}`;
        if (endDate === fullMonthEnd) {
            return `${appName}_${monthStart[1]}-${monthStart[2]}`;
        }
    }
    return `${appName}_${startDate}_${endDate}`;
}

/** 从 Daily Notes 核心插件获取配置，失败返回 null */
function getDailyNoteConfig(app: App): { format: string; folder: string } | null {
    try {
        const internalPlugins = (app as unknown as { internalPlugins: { getPluginById(id: string): { enabled: boolean; instance: { options?: { format?: string; folder?: string } } } | null } }).internalPlugins;
        const plugin = internalPlugins.getPluginById('daily-notes');
        if (!plugin?.enabled) return null;
        const options = plugin.instance.options;
        if (!options) return null;
        const format = typeof options.format === 'string'
            ? options.format.replace(/YYYY/g, 'yyyy').replace(/DD/g, 'dd')
            : null;
        const folder = typeof options.folder === 'string' ? options.folder : null;
        if (!format && !folder) return null;
        return { format: format || 'yyyy-MM-dd', folder: folder || '' };
    } catch {
        return null;
    }
}

// ── 日期格式工具函数 ─────────────────────────────────────────────────────────

interface DateFormatToken {
    component: 'year' | 'year2' | 'month' | 'day';
}

// 中文星期字符（周日/周天均匹配星期日）
const WEEKDAY_CHAR_REGEX = /[一二三四五六日天]/;
// 中文星期映射：getDay() 0=周日, 1=周一, ..., 6=周六
const WEEKDAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];

const formatTokenCache = new Map<string, { regex: RegExp; tokens: DateFormatToken[] }>();

/** 解析日期格式字符串，返回正则和 token 数组（结果缓存）
 *  tokens 只包含带捕获组的日期分量（year/year2/month/day），
 *  星期/周 等无捕获组的 token 不入列，保证 tokens 索引与 match[1..] 对齐。 */
function parseFormatTokens(format: string): { regex: RegExp; tokens: DateFormatToken[] } {
    const cached = formatTokenCache.get(format);
    if (cached) return cached;

    const tokens: DateFormatToken[] = [];
    let pattern = '';
    let i = 0;
    while (i < format.length) {
        if ((format.startsWith('YYYY', i) || format.startsWith('yyyy', i)) && (i + 4 <= format.length)) {
            pattern += '(\\d{4})';
            tokens.push({ component: 'year' });
            i += 4;
        } else if ((format.startsWith('YY', i) || format.startsWith('yy', i)) && (i + 2 <= format.length)) {
            pattern += '(\\d{2})';
            tokens.push({ component: 'year2' });
            i += 2;
        } else if (format.startsWith('MM', i)) {
            pattern += '(\\d{2})';
            tokens.push({ component: 'month' });
            i += 2;
        } else if ((format.startsWith('DD', i) || format.startsWith('dd', i)) && (i + 2 <= format.length)) {
            pattern += '(\\d{2})';
            tokens.push({ component: 'day' });
            i += 2;
        } else if (format.startsWith('星期', i)) {
            pattern += '星期[一二三四五六日天]';
            i += 2;
            if (i < format.length && WEEKDAY_CHAR_REGEX.test(format[i])) i += 1;
        } else if (format[i] === '周') {
            pattern += '周[一二三四五六日天]';
            i += 1;
            if (i < format.length && WEEKDAY_CHAR_REGEX.test(format[i])) i += 1;
        } else {
            pattern += escapeRegex(format[i]);
            i += 1;
        }
    }
    const result = { regex: new RegExp(pattern), tokens };
    formatTokenCache.set(format, result);
    return result;
}

/** 按配置格式生成日期字符串 */
function formatFileDate(date: Date, format: string): string {
    const year4 = date.getFullYear().toString();
    const year2 = year4.slice(-2);
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const weekdayChar = WEEKDAY_CHARS[date.getDay()];
    return format
        .replace(/yyyy|YYYY/g, year4)
        .replace(/yy|YY/g, year2)
        .replace(/MM/g, month)
        .replace(/dd|DD/g, day)
        .replace(/星期[一二三四五六日天]?/g, '星期' + weekdayChar)
        .replace(/周[一二三四五六日天]?/g, '周' + weekdayChar);
}

/** 生成匹配日期文件名的正则（用于文件过滤） */
function buildFilenameRegex(format: string): RegExp {
    const { regex } = parseFormatTokens(format);
    return new RegExp('^' + regex.source + '\\.md$');
}

/** 从正则匹配结果中提取 ISO 日期 */
function extractISOFromMatch(match: RegExpMatchArray, tokens: DateFormatToken[]): string | null {
    let year = '', month = '', day = '';
    for (let i = 0; i < tokens.length; i++) {
        const val = match[i + 1];
        if (tokens[i].component === 'year') year = val;
        else if (tokens[i].component === 'year2') year = '20' + val;
        else if (tokens[i].component === 'month') month = val;
        else if (tokens[i].component === 'day') day = val;
    }
    const iso = `${year}-${month}-${day}`;
    const parsed = new Date(iso);
    if (isNaN(parsed.getTime())) return null;
    return iso;
}

/** 从相对路径提取日期，返回 ISO 字符串 */
function parseDateFromPath(relativePath: string, format: string): string | null {
    const { regex, tokens } = parseFormatTokens(format);
    const fullRegex = new RegExp('^' + regex.source + '\\.md$');
    const match = relativePath.match(fullRegex);
    if (!match) return null;
    return extractISOFromMatch(match, tokens);
}

/** 从字符串中提取日期，返回 ISO 字符串 */
function parseDateFromString(str: string, format: string): string | null {
    const { regex, tokens } = parseFormatTokens(format);
    const match = str.match(regex);
    if (!match) return null;
    return extractISOFromMatch(match, tokens);
}

/** ISO 日期转换为文件格式日期 */
function isoToFileDate(isoDate: string, format: string): string {
    const parts = isoDate.split('-');
    if (parts.length !== 3) return isoDate;
    return formatFileDate(
        new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])),
        format
    );
}

/** 补录日期正则：同时匹配配置格式和 ISO 格式 */
function buildBackfillRegex(format: string): RegExp {
    const { regex } = parseFormatTokens(format);
    return new RegExp('(' + regex.source + '|\\d{4}-\\d{2}-\\d{2})');
}

// ── 账单解析器基础结构 ─────────────────────────────────────────────────────────

/** 支持的截图页面类型 */
type BillSource = 'wechat_bill' | 'wechat_history' | 'alipay' | 'ccb' | 'unknown';

/** 解析后的账单信息 */
interface BillInfo {
    source: BillSource;        // 识别到的截图页面类型
    time: string;              // 交易时间，如 "20:58"
    merchant: string;          // 付款方/商户名
    amount: number;            // 金额
    rawText: string;           // 原始文本
}

/** 单个页面解析器接口 */
interface BillParser {
    /** 判断文本是否来自该页面类型（特征关键词/结构匹配） */
    detect(lines: string[]): boolean;
    /** 解析文本，返回 BillInfo（不含 source/rawText，由调用方填充） */
    parse(lines: string[]): Omit<BillInfo, 'source' | 'rawText'> | null;
}

// ── 公共工具 ──────────────────────────────────────────────────────────────────

/** 从行列表中向上查找商户名（金额行索引之前，跳过状态/信号/时间行） */
function findMerchantAbove(lines: string[], amountLineIdx: number): string {
    const skipPatterns = [
        /^\d{1,3}$/,                                          // 纯数字（电量、信号格数）
        /^[45]G$/i,                                           // 信号标识
        /^(完成|支付成功|转账成功|已完成|付款方|收款方|确认付款)/,  // 状态行
        /^[•·…\-\s]+$/,                                      // 装饰行
        /^使用.+支付$/,                                       // 付款方式行（亲属卡等）
        /^交易状态/,                                           // 交易状态标签行
        /^(已转账|已退款|已收款|待确认|已关闭|对方已收款)/,       // 交易状态值
    ];
    for (let i = amountLineIdx - 1; i >= 0; i--) {
        const line = lines[i];
        if (skipPatterns.some(p => p.test(line))) continue;
        if (/^\d{1,2}:\d{2}/.test(line)) continue; // 跳过时间行
        return line;
    }
    return '';
}

/** 从行列表中提取 HH:MM 格式时间 */
function extractTime(lines: string[]): string {
    for (const line of lines) {
        const m = line.match(/(\d{1,2}:\d{2})/);
        if (m) return m[1];
    }
    return '';
}

// ── 微信支付解析器 ────────────────────────────────────────────────────────────
// 特征：金额行前缀为 · (middle dot)，状态行含"完成"
// 微信支付完成页（支付后弹出的页面，含「支付成功」/「返回商家」/「完成」字样）
// 注意：支付宝完成页也有「完成」，但支付宝解析器排在前面（用「完成」+「付款方式」检测），
// 所以走到这里的「完成」可以安全归为微信
const wechatBillParser: BillParser = {
    detect(lines) {
        return lines.some(l => /^完成$/.test(l) || /^返回商家$/.test(l) || l.includes('支付成功'));
    },
    parse(lines) {
        // 从后往前找最后一个金额行，一个截图可能含多笔记录，只取最后一笔
        // OCR 对 ¥ 的误识别很多（· * . Y 等），只要行内能提取出 数字.数字 且行较短即可
        let amountLineIdx = -1;
        let amount = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (line.length > 20) continue; // 金额行不会太长
            const m = line.match(/([\d]+\.[\d]{1,2})\s*$/);
            if (m) {
                const val = parseFloat(m[1]);
                if (val > 0) { amount = val; amountLineIdx = i; break; }
            }
        }
        if (amountLineIdx === -1 || amount <= 0) return null;
        const merchant = findMerchantAbove(lines, amountLineIdx);
        if (!merchant) return null;
        return { time: extractTime(lines), merchant, amount };
    }
};

// 微信支付账单列表页（主动打开微信支付看到的账单页，含「我的账单」+「支付服务」）
// 页面可能含多笔记录，只取「我的账单」标签行之前的最后一笔
const wechatHistoryParser: BillParser = {
    detect(lines) {
        return lines.some(l => l.includes('我的账单')) &&
               lines.some(l => l.includes('支付服务'));
    },
    parse(lines) {
        // 截取到「我的账单」之前的内容，避免底部导航栏文字干扰
        const cutoff = lines.findIndex(l => l.includes('我的账单'));
        const searchLines = cutoff > 0 ? lines.slice(0, cutoff) : lines;

        // 从后往前找最后一个金额行
        let amountLineIdx = -1;
        let amount = 0;
        for (let i = searchLines.length - 1; i >= 0; i--) {
            const line = searchLines[i];
            if (line.length > 20) continue;
            const m = line.match(/([\d]+\.[\d]{1,2})\s*$/);
            if (m) {
                const val = parseFloat(m[1]);
                if (val > 0) { amount = val; amountLineIdx = i; break; }
            }
        }
        if (amountLineIdx === -1 || amount <= 0) return null;

        // 向上找商户名，跳过付款方式行（「使用XX支付」）、交易状态和噪声行
        const skipPatterns = [
            /^使用.+支付$/,
            /^账单详情/,
            /^\d{1,3}$/,
            /^[45]G$/i,
            /^[•·…\-\s]+$/,
            /^交易状态/,
            /^(已转账|已退款|已收款|待确认|已关闭|对方已收款)/,
        ];
        let merchant = '';
        for (let i = amountLineIdx - 1; i >= 0; i--) {
            const line = searchLines[i];
            if (skipPatterns.some(p => p.test(line))) continue;
            if (/^\d{1,2}:\d{2}/.test(line)) continue;
            merchant = line;
            break;
        }
        if (!merchant) return null;

        return { time: extractTime(searchLines), merchant, amount };
    }
};

// 建设银行动账提醒页（微信内收到的银行消息通知，含「动账提醒」字样）
// 从结构化字段中提取：交易对象（商户）、交易金额、交易时间
const ccbNotificationParser: BillParser = {
    detect(lines) {
        return lines.some(l => l.includes('动账提醒') || l.includes('变动提醒'));
    },
    parse(lines) {
        // 交易金额：优先从「交易金额：」行取，兼容金额在下一行的情况
        let amount = 0;
        const amountLabelIdx = lines.findIndex(l => /^交易金额/.test(l));
        if (amountLabelIdx >= 0) {
            const sameLineMatch = lines[amountLabelIdx].match(/[：:]\s*([\d.]+)/);
            if (sameLineMatch) {
                amount = parseFloat(sameLineMatch[1]);
            } else {
                for (let i = amountLabelIdx + 1; i < lines.length; i++) {
                    const m = lines[i].match(/^([\d.]+)$/);
                    if (m) { amount = parseFloat(m[1]); break; }
                }
            }
        }
        // 兜底：从 ·-10.00 格式取绝对值
        if (!amount) {
            for (const line of lines) {
                const m = line.match(/^[··]-?\s*([\d]+\.[\d]{1,2})\s*$/);
                if (m) { amount = parseFloat(m[1]); break; }
            }
        }
        if (!amount || amount <= 0) return null;

        // 交易对象：去掉「微信支付-」「支付宝-」等前缀，得到真实商户名
        let merchant = '';
        const merchantLine = lines.find(l => /^交易对象/.test(l));
        if (merchantLine) {
            const m = merchantLine.match(/[：:]\s*(.+)/);
            if (m) {
                merchant = m[1]
                    .replace(/^微信支付[-–—]/, '')
                    .replace(/^支付宝[-–—]/, '')
                    .trim();
            }
        }
        if (!merchant) return null;

        // 交易时间：从「交易时间：2026/03/31 12:42:19」中提取 HH:MM
        let time = '';
        const timeLine = lines.find(l => /^交易时间/.test(l));
        if (timeLine) {
            const m = timeLine.match(/(\d{1,2}:\d{2})/);
            if (m) time = m[1];
        }

        return { time, merchant, amount };
    }
};

// ── 支付宝完成页解析器 ────────────────────────────────────────────────────────
// 特征：同时含「完成」和「付款方式」（微信完成页无「付款方式」字段）
// 结构：商户简称 → 完成 → ·金额 → 商户全名 → 付款方式 → ·金额 → 银行卡
const alipayBillParser: BillParser = {
    detect(lines) {
        return lines.some(l => /^完成$/.test(l)) &&
               lines.some(l => /^付款方式$/.test(l));
    },
    parse(lines) {
        // 找「完成」行之后的第一个金额行
        const doneIdx = lines.findIndex(l => /^完成$/.test(l));
        if (doneIdx === -1) return null;

        let amountLineIdx = -1;
        let amount = 0;
        for (let i = doneIdx + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.length > 20) continue;
            const m = line.match(/([\d]+\.[\d]{1,2})\s*$/);
            if (m) {
                const val = parseFloat(m[1]);
                if (val > 0) { amount = val; amountLineIdx = i; break; }
            }
        }
        if (!amount || amountLineIdx === -1) return null;

        // 商户全名在金额行和「付款方式」行之间
        const payMethodIdx = lines.findIndex((l, i) => i > amountLineIdx && /^付款方式$/.test(l));
        let merchant = '';
        if (payMethodIdx > amountLineIdx + 1) {
            // 取金额行和付款方式之间的第一个非空行
            for (let i = amountLineIdx + 1; i < payMethodIdx; i++) {
                const line = lines[i];
                if (line && !/^\d{1,3}$/.test(line) && !/^[•·…\-\s]+$/.test(line)) {
                    merchant = line;
                    break;
                }
            }
        }
        // 兜底：如果中间没找到，取「完成」上方的商户名
        if (!merchant) {
            merchant = findMerchantAbove(lines, doneIdx);
        }
        if (!merchant) return null;

        return { time: extractTime(lines), merchant, amount };
    }
};

// ── 解析器注册表（按优先级排列，顺序即匹配顺序） ──────────────────────────────
const BILL_PARSERS: Array<{ source: BillSource; parser: BillParser }> = [
    { source: 'wechat_history', parser: wechatHistoryParser },
    { source: 'alipay',         parser: alipayBillParser },
    { source: 'wechat_bill',    parser: wechatBillParser },
    { source: 'ccb',            parser: ccbNotificationParser },
];

// ── 入口函数 ──────────────────────────────────────────────────────────────────

/**
 * 从 OCR 文字内容中识别截图页面类型并解析账单信息。
 * 返回 null 表示无法识别页面类型。
 */
function parseBillContent(content: string): BillInfo | null {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return null;

    for (const { source, parser } of BILL_PARSERS) {
        if (!parser.detect(lines)) continue;
        const result = parser.parse(lines);
        if (!result) {
            // 页面识别成功但解析失败
            return { source, time: '', merchant: '', amount: 0, rawText: content };
        }
        return { source, rawText: content, ...result };
    }

    // 未能识别任何页面类型
    return null;
}

/** 根据商户名自动匹配分类和描述 */
function matchMerchantCategory(config: AccountingConfig, merchant: string): { keyword: string; description: string } {
    const merchantMap: Record<string, MerchantMapEntry | string> = config.billMerchantMap || {};
    for (const [pattern, entry] of recordEntries(merchantMap)) {
        if (!merchant.includes(pattern)) continue;
        if (typeof entry === 'string') {
            return { keyword: entry, description: '' };
        }
        return {
            keyword: entry.category || '',
            description: entry.description ?? '',
        };
    }
    const cleanedMerchant = merchant.replace(/[（(][^）)]*[）)]/g, '').trim();
    return {
        keyword: config.defaultCategory || Object.keys(config.categories)[0] || '',
        description: cleanedMerchant,
    };
}

// ── 批量重分类引擎 ─────────────────────────────────────────────────────────────

/** 转义正则特殊字符 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 用新的分类、描述和金额重建记账行。
 * 保留原行的列表符号、emoji 与关键词之间的写法，以及"金额在前"还是"备注在前"的原始顺序。
 * 例：'- #cy 午饭 25' + ('cy', '晚饭', 30) => '- #cy 晚饭 30'
 * 例：'- #cy 25 午餐' + ('gw', '午餐', 30) => '- #gw 30 午餐'
 */
function buildEditedRecordLine(
    record: AccountingRecord,
    toKeyword: string,
    description: string,
    amount: number,
    expenseEmoji: string
): string {
    // 解析器允许 emoji 与关键词之间有空格且大小写不敏感，这里按同样规则定位标记段
    const markerRegex = new RegExp(
        `(${escapeRegex(expenseEmoji)})(\\s*)(${escapeRegex(record.keyword)})`, 'i'
    );
    const match = markerRegex.exec(record.rawLine);
    const prefix = match ? record.rawLine.slice(0, match.index) : '- ';
    const marker = match ? `${match[1]}${match[2]}${toKeyword}` : expenseEmoji + toKeyword;
    const rest = match ? record.rawLine.slice(match.index + match[0].length).trim() : '';

    const desc = description.trim();
    if (!desc) return `${prefix}${marker} ${amount}`;

    // 原行把金额写在备注前面时保持同样顺序，避免编辑后行内容被重排。
    // 只有开头这个数字确实是被解析成金额的那个数字时才算"金额在前"，
    // 否则形如 "#cy 2026-08-01 补录午饭 25" 的备注会被误判。
    const leading = /^[\d.]+/.exec(rest);
    const amountFirst = leading !== null && parseFloat(leading[0]) === record.amount;
    return amountFirst
        ? `${prefix}${marker} ${amount} ${desc}`
        : `${prefix}${marker} ${desc} ${amount}`;
}

class ReclassifyEngine {
    /**
     * 校验规则列表，返回所有错误（空数组表示通过）
     */
    static validateRules(rules: ReclassifyRule[]): ValidationError[] {
        const errors: ValidationError[] = [];
        rules.forEach((rule, index) => {
            const ruleIndex = index + 1;
            if (!rule.keyword || rule.keyword.trim() === '') {
                errors.push({ ruleIndex, message: `规则 ${ruleIndex}：备注关键词不能为空` });
            }
            if (!rule.toCategory) {
                errors.push({ ruleIndex, message: `规则 ${ruleIndex}：请选择目标分类` });
            }
        });
        return errors;
    }

    /**
     * 判断单条记录是否匹配规则
     * - record.description 包含 rule.keyword（大小写不敏感）
     * - rule.fromCategory 为空 OR 等于 record.keyword
     */
    static matchRecord(rule: ReclassifyRule, record: AccountingRecord): boolean {
        // 支持 | 分隔多个关键词，任意一个命中即匹配（不区分大小写）
        const keywords = rule.keyword.split('|').map(k => k.trim()).filter(k => k.length > 0);
        const descLower = record.description.toLowerCase();
        const descriptionMatches = keywords.some(k => descLower.includes(k.toLowerCase()));
        const categoryMatches = rule.fromCategory === '' || rule.fromCategory === record.keyword;
        return descriptionMatches && categoryMatches;
    }

    /**
     * 将 rawLine 中的 {expenseEmoji}{fromKeyword} 替换为 {expenseEmoji}{toKeyword}
     * 仅替换第一个匹配项
     */
    static replaceKeyword(
        rawLine: string,
        fromKeyword: string,
        toKeyword: string,
        expenseEmoji: string,
        rewriteDescription?: string
    ): string {
        // 替换分类关键词
        const pattern = new RegExp(escapeRegex(expenseEmoji) + escapeRegex(fromKeyword));
        let result = rawLine.replace(pattern, expenseEmoji + toKeyword);

        // 如果有重写备注，替换备注部分
        // rawLine 格式：- #keyword 备注 金额
        // 找到金额（最后一个数字），把金额前的备注部分替换
        if (rewriteDescription && rewriteDescription.trim() !== '') {
            // 匹配：expenseEmoji + toKeyword + 空格 + (备注内容) + 空格 + 金额
            const descPattern = new RegExp(
                `(${escapeRegex(expenseEmoji)}${escapeRegex(toKeyword)}\\s+)(.+?)(\\s+[\\d.]+\\s*$)`
            );
            const descMatch = result.match(descPattern);
            if (descMatch) {
                result = result.replace(descPattern, `$1${rewriteDescription}$3`);
            }
        }

        return result;
    }

    /**
     * Dry Run：扫描所有记录，返回预览结果
     */
    static dryRun(
        rules: ReclassifyRule[],
        records: AccountingRecord[],
        expenseEmoji: string,
        journalsPath: string,
        dateFormat: string
    ): PreviewResult {
        const matches: ReclassifyMatch[] = [];

        for (const record of records) {
            // 按规则列表顺序匹配，取第一条命中规则（先到先得）
            for (const rule of rules) {
                if (ReclassifyEngine.matchRecord(rule, record)) {
                    // 原始分类已经是目标分类，且没有备注重写规则，跳过
                    if (record.keyword === rule.toCategory && !rule.rewriteDescription) break;
                    // 原始分类已经是目标分类，有备注重写规则但备注已经一致，跳过
                    if (record.keyword === rule.toCategory && rule.rewriteDescription && record.description === rule.rewriteDescription) break;

                    const newRawLine = ReclassifyEngine.replaceKeyword(
                        record.rawLine,
                        record.keyword,
                        rule.toCategory,
                        expenseEmoji,
                        rule.rewriteDescription
                    );
                    const filePath = `${journalsPath}/${isoToFileDate(record.fileDate, dateFormat)}.md`;
                    matches.push({ rule, record, newRawLine, filePath });
                    break; // 先到先得，只取第一条匹配规则
                }
            }
        }

        const fileCount = new Set(matches.map(m => m.filePath)).size;

        return {
            matches,
            totalCount: matches.length,
            fileCount,
        };
    }

    /**
     * 批量改分类：根据日期范围和源分类筛选，生成预览结果
     */
    static batchCategoryDryRun(
        records: AccountingRecord[],
        startDate: string,
        endDate: string,
        fromKeywords: string[],
        toKeyword: string,
        expenseEmoji: string,
        journalsPath: string,
        dateFormat: string
    ): BatchCategoryPreview {
        const matches: BatchCategoryMatch[] = [];
        const fromSet = new Set(fromKeywords);

        for (const record of records) {
            if (record.keyword === toKeyword) continue;
            if (!fromSet.has(record.keyword)) continue;
            if (record.date < startDate || record.date > endDate) continue;

            const newRawLine = ReclassifyEngine.replaceKeyword(
                record.rawLine,
                record.keyword,
                toKeyword,
                expenseEmoji
            );
            const filePath = `${journalsPath}/${isoToFileDate(record.fileDate, dateFormat)}.md`;
            matches.push({ record, toCategory: toKeyword, newRawLine, filePath });
        }

        const fileCount = new Set(matches.map(m => m.filePath)).size;
        return { matches, totalCount: matches.length, fileCount };
    }

    /**
     * Commit：将预览结果写回文件
     * 每个文件只读写一次（原子操作）
     * @returns 写入失败的文件路径列表
     */
    static async commit(
        app: App,
        previewResult: PreviewResult
    ): Promise<string[]> {
        // 按 filePath 对 matches 分组
        const fileGroups = new Map<string, ReclassifyMatch[]>();
        for (const match of previewResult.matches) {
            if (!fileGroups.has(match.filePath)) {
                fileGroups.set(match.filePath, []);
            }
            fileGroups.get(match.filePath)!.push(match);
        }

        const failedFiles: string[] = [];

        for (const [filePath, fileMatches] of fileGroups) {
            try {
                const file = app.vault.getAbstractFileByPath(filePath);
                if (!(file instanceof TFile)) {
                    new Notice(`文件 ${filePath} 写入失败，该文件的修改已跳过`);
                    failedFiles.push(filePath);
                    continue;
                }

                // 原子读-改-写：读取文件内容
                let content = await app.vault.read(file);
                const originalContent = content;

                // 逐条字符串替换（非正则，确保精确匹配）
                for (const match of fileMatches) {
                    content = content.replace(match.record.rawLine, match.newRawLine);
                }

                // 内容无变化则跳过写入，避免修改文件时间戳
                if (content === originalContent) continue;

                // 写回文件
                await app.vault.modify(file, content);
            } catch {
                new Notice(`文件 ${filePath} 写入失败，该文件的修改已跳过`);
                failedFiles.push(filePath);
            }
        }

        return failedFiles;
    }
}

// 记账记录解析器
class AccountingParser {
    config: AccountingConfig;
    
    constructor(config: AccountingConfig) {
        this.config = config;
    }

    // 解析单行记账记录
    parseRecord(line: string, fileDate: string): AccountingRecord | null {
        const { categories, expenseEmoji } = this.config;
        
        // 检查是否包含记账表情符号
        if (!line.includes(expenseEmoji)) {
            return null;
        }

        // 创建关键词列表，按长度排序（避免短关键词匹配长关键词的一部分）
        const keywords = Object.keys(categories).sort((a, b) => b.length - a.length);
        const keywordPattern = keywords.join('|');
        
        // 第一步：匹配 #关键词 后面的所有内容（支持无空格格式）
        const keywordRegex = new RegExp(`${expenseEmoji}\\s*(${keywordPattern})\\s*(.+)`, 'i');
        const keywordMatch = keywordRegex.exec(line);
        
        if (!keywordMatch) return null;

        const keyword = keywordMatch[1];
        const restContent = keywordMatch[2]; // #cy 后面的所有内容
        
        // 第二步：从剩余内容中提取第一个出现的数字作为金额
        const amountRegex = /[\d.]+/;
        const amountMatch = restContent.match(amountRegex);
        
        if (!amountMatch) return null;
        
        const amount = parseFloat(amountMatch[0]);
        if (isNaN(amount) || amount <= 0) return null;
        
        const category = categories[keyword] || '未分类';
        const isIncome = keyword === 'sr';
        
        // 第三步：提取描述（移除金额和紧跟的货币单位）
        // 匹配金额后面可能跟着的货币单位：块钱、元、块（按长度排序）
        const amountWithUnit = new RegExp(amountMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(块钱|元|块)?');
        const description = restContent.replace(amountWithUnit, '').trim();
        
        // 检查描述中是否包含日期（支持账单补录，兼容配置格式和 ISO 格式）
        let recordDate = fileDate;
        const dateRegex = buildBackfillRegex(this.config.dateFormat);
        const dateMatch = description.match(dateRegex);

        if (dateMatch) {
            const matchedDate = dateMatch[1];
            // 如果是 ISO 格式直接使用，否则从配置格式转换
            if (/^\d{4}-\d{2}-\d{2}$/.test(matchedDate)) {
                recordDate = matchedDate;
            } else {
                const isoDate = parseDateFromString(matchedDate, this.config.dateFormat);
                if (isoDate) recordDate = isoDate;
            }
        }
        
        return {
            date: recordDate,
            fileDate: fileDate, // 保留原文件日期用于追溯
            keyword,
            category,
            amount: parseFloat(amount),
            isIncome,
            description: description.trim(),
            rawLine: line.trim(),
            isBackfill: recordDate !== fileDate // 标记是否为补录
        };
    }

    // 解析文件内容
    parseFileContent(content: string, filePath: string): AccountingRecord[] {
        const lines = content.split('\n');
        const records: AccountingRecord[] = [];
        
        // 从文件路径提取日期（使用配置的日期格式）
        const journalsPrefix = this.config.journalsPath + '/';
        let relativePath = filePath;
        if (filePath.startsWith(journalsPrefix)) {
            relativePath = filePath.substring(journalsPrefix.length);
        }
        const fileDate = parseDateFromPath(relativePath, this.config.dateFormat) || formatLocalDate(new Date());

        lines.forEach(line => {
            const record = this.parseRecord(line, fileDate);
            if (record) {
                records.push(record);
            }
        });

        return records;
    }
}

// 记账数据管理器
class AccountingStorage {
    app: App;
    config: AccountingConfig;
    parser: AccountingParser;
    cache: {
        records: AccountingRecord[] | null;
        lastUpdate: number | null;
    };
    cacheTimeout: number;

    constructor(app: App, config: AccountingConfig) {
        this.app = app;
        this.config = config;
        this.parser = new AccountingParser(config);
        
        // 添加缓存机制
        this.cache = {
            records: null,
            lastUpdate: null
        };
        
        // 缓存有效期（30秒）
        this.cacheTimeout = 30 * 1000;
    }
    
    // 检查缓存是否有效
    isCacheValid() {
        if (!this.cache.records || !this.cache.lastUpdate) {
            return false;
        }
        
        const now = Date.now();
        if ((now - this.cache.lastUpdate) > this.cacheTimeout) {
            return false;
        }
        
        return true;
    }

    // 获取所有记账记录 - 智能缓存版本（已禁用，改为实时加载）
    async getAllRecordsWithCache(forceRefresh = false) {
        // 如果强制刷新，清除缓存
        if (forceRefresh) {
            this.clearCache();
        }
        
        // 如果缓存有效，直接返回
        if (this.isCacheValid()) {
            return this.cache.records;
        }
        
        let records = [];
        
        try {
            // 优先使用搜索方式，更高效
            records = await this.getAllRecordsBySearch();
            
            // 更新缓存
            this.cache.records = records;
            this.cache.lastUpdate = Date.now();
            
            return records;
            
        } catch (error) {
            console.error('获取记账记录失败:', error);
            new Notice('获取记账记录失败，请检查日记文件夹');
            
            // 如果有缓存，返回缓存数据
            if (this.cache.records) {
                new Notice('使用缓存数据');
                return this.cache.records;
            }
            
            return [];
        }
    }
    
    // 清除缓存
    clearCache() {
        this.cache.records = null;
        this.cache.lastUpdate = null;
    }

    /**
     * 日记文件变化时调用（vault / metadataCache 事件），清除缓存
     * @returns 是否为日记文件且已清除缓存（用于决定是否刷新视图）
     */
    onFileChange(file: TFile): boolean {
        if (file.path.startsWith(this.config.journalsPath + '/') && file.extension === 'md') {
            this.clearCache();
            return true;
        }
        return false;
    }

    // 获取所有记账记录 - 每次都实时加载
    async getAllRecords(_forceRefresh = false): Promise<AccountingRecord[]> {
        let records = [];
        
        try {
            // 优先使用搜索方式，更高效
            records = await this.getAllRecordsBySearch();
            
            return records;
            
        } catch (error) {
            console.error('❌ 获取记账记录失败:', error);
            new Notice('获取记账记录失败，请检查日记文件夹');
            return [];
        }
    }
    
    // 使用搜索 API 的方式 - 基于配置的关键词搜索
    async getAllRecordsBySearch(): Promise<AccountingRecord[]> {
        const records: AccountingRecord[] = [];
        const { expenseEmoji, categories } = this.config;

        try {
            // 获取所有配置的关键词
            const keywords = Object.keys(categories);

            // 检查今天和最近几天的文件是否存在
            const today = new Date();
            const checkDates = [];
            for (let i = 0; i < 5; i++) {
                const date = new Date(today);
                date.setDate(date.getDate() - i);
                const dateStr = formatFileDate(date, this.config.dateFormat);
                const fileName = `${dateStr}.md`;
                const filePath = `${this.config.journalsPath}/${fileName}`;
                const file = this.app.vault.getAbstractFileByPath(filePath);
                checkDates.push({
                    date: dateStr,
                    exists: file !== null,
                    path: filePath
                });
            }
            
            // 使用关键词搜索文件
            const searchResults = await this.searchFilesWithKeywords(keywords, expenseEmoji);

            // 只处理搜索到的文件
            for (const file of searchResults) {
                try {
                    const content = await this.app.vault.read(file);
                    const fileRecords = this.parser.parseFileContent(content, file.path);
                    if (fileRecords.length > 0) {
                        records.push(...fileRecords);
                    }
                } catch (error) {
                    console.error(`  ✗ 读取文件 ${file.path} 失败:`, error);
                }
            }

            return records.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            
        } catch (error) {
            console.error('❌ 关键词搜索功能失败:', error);
            // 如果搜索失败，回退到优化的遍历方式
            return await this.getAllRecordsByOptimizedTraversal();
        }
    }
    
    // 搜索包含指定关键词的文件 - 使用 Obsidian 搜索引擎
    async searchFilesWithKeywords(keywords: string[], expenseEmoji: string): Promise<TFile[]> {
        try {
            // 尝试使用 Obsidian 的搜索引擎
            const searchResults = await this.useObsidianSearchEngine(keywords, expenseEmoji);
            if (searchResults.length > 0) {
                return searchResults;
            }
        } catch {
            // ignore error, will fall back to custom search
        }

        // 回退到自定义关键词搜索
        return await this.useCustomKeywordSearch(keywords, expenseEmoji);
    }
    
    // 使用 Obsidian 搜索引擎
    async useObsidianSearchEngine(keywords: string[], expenseEmoji: string): Promise<TFile[]> {
        const matchingFiles = new Set<TFile>();

        // 尝试使用搜索引擎
        try {
            // 检查是否有搜索插件
            const internalPlugins = (this.app as unknown as { internalPlugins?: InternalPlugins }).internalPlugins;
            const searchPlugin = internalPlugins?.plugins?.['global-search'];
            if (searchPlugin && searchPlugin.enabled) {
                const searchInstance = searchPlugin.instance;

                // 为每个关键词执行搜索
                for (const keyword of keywords) {
                    const searchTerm = `${expenseEmoji}${keyword}`;

                    try {
                        // 执行搜索

                        // 尝试不同的搜索方法
                        let results: SearchResult[] | null = null;

                        // 方法1: 使用搜索引擎的 searchText 方法
                        if (searchInstance.searchEngine?.searchText) {
                            results = await searchInstance.searchEngine.searchText(searchTerm, {
                                path: this.config.journalsPath
                            });
                        }

                        // 方法2: 使用搜索引擎的 search 方法
                        if (!results && searchInstance.searchEngine?.search) {
                            results = await searchInstance.searchEngine.search(searchTerm);
                        }

                        // 处理搜索结果
                        if (results && results.length > 0) {
                            results.forEach((result: { file?: TFile; path?: string }) => {
                                if (result.file && result.file.path.startsWith(this.config.journalsPath)) {
                                    matchingFiles.add(result.file);
                                } else if (result.path && result.path.startsWith(this.config.journalsPath)) {
                                    const file = this.app.vault.getAbstractFileByPath(result.path);
                                    if (file instanceof TFile) {
                                        matchingFiles.add(file);
                                    }
                                }
                            });
                        }

                    } catch {
                        // ignore error for this keyword, continue with others
                    }
                }

                if (matchingFiles.size > 0) {
                    return Array.from(matchingFiles);
                }
            }
        } catch {
            // ignore error, will fall back to custom search
        }

        // 搜索引擎未找到结果，返回空数组而不是抛出错误
        return [];
    }
    
    // 自定义关键词搜索实现 - 只扫描日期格式的文件
    async useCustomKeywordSearch(keywords: string[], expenseEmoji: string): Promise<TFile[]> {
        const { vault, metadataCache } = this.app;
        const matchingFiles = new Set<TFile>();

        // 获取所有 journals 文件夹下的 markdown 文件
        const allFiles = vault.getMarkdownFiles().filter(file =>
            file.path.startsWith(this.config.journalsPath)
        );

        // 只保留符合日期格式的文件
        const datePattern = buildFilenameRegex(this.config.dateFormat);
        const journalsPrefix = this.config.journalsPath + '/';
        const dateFiles = allFiles.filter(file => {
            if (!file.path.startsWith(journalsPrefix)) return false;
            const relativePath = file.path.substring(journalsPrefix.length);
            return datePattern.test(relativePath);
        });
        
        // 构建正则表达式 - 匹配 #关键词 后面跟数字（可能有空格，也可能没有）
        const keywordPattern = keywords.join('|');
        // 注意：不使用 g 标志，避免 lastIndex 状态问题
        const searchPattern = `${expenseEmoji}\\s*(${keywordPattern})\\s*.*?[\\d.]+`;
        
        // 使用并行搜索，但分批处理以避免性能问题
        const batchSize = 50;
        
        for (let i = 0; i < dateFiles.length; i += batchSize) {
            const batch = dateFiles.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (file) => {
                try {
                    let content: string;
                    
                    // 尝试从缓存获取内容
                    const cachedMetadata = metadataCache.getFileCache(file);
                    if (cachedMetadata && cachedMetadata.sections) {
                        content = await vault.cachedRead(file);
                    } else {
                        content = await vault.read(file);
                    }
                    
                    // 使用正则表达式检查是否包含有效的记账记录
                    // 每次都创建新的正则对象，避免 g 标志的状态问题
                    const regex = new RegExp(searchPattern);
                    if (regex.test(content)) {
                        return file;
                    }
                    return null;
                } catch (error) {
                    console.error(`  ✗ 检查文件 ${file.path} 失败:`, error);
                    return null;
                }
            });

            const batchResults = await Promise.all(batchPromises);
            const validFiles = batchResults.filter((file): file is TFile => file !== null);
            validFiles.forEach(file => matchingFiles.add(file));
        }

        return Array.from(matchingFiles);
    }
    
    // 优化的遍历方式：预筛选 + 并行处理
    async getAllRecordsByOptimizedTraversal(): Promise<AccountingRecord[]> {
        const { vault } = this.app;
        const { expenseEmoji } = this.config;
        
        // 检查文件夹是否存在
        const journalsFolder = vault.getAbstractFileByPath(this.config.journalsPath);
        if (!journalsFolder) {
            new Notice(`未找到 ${this.config.journalsPath} 文件夹`);
            return [];
        }

        // 获取所有 journals 文件夹下的 markdown 文件
        const allFiles = vault.getMarkdownFiles().filter(file =>
            file.path.startsWith(this.config.journalsPath)
        );

        // 分批处理文件，避免一次性读取太多文件
        const batchSize = 10;
        const records: AccountingRecord[] = [];

        for (let i = 0; i < allFiles.length; i += batchSize) {
            const batch = allFiles.slice(i, i + batchSize);

            const batchPromises = batch.map(async (file) => {
                try {
                    // 先读取文件的前几行来快速检查是否包含记账标识符
                    const content = await vault.read(file);

                    // 快速检查：如果文件不包含记账标识符，跳过
                    if (!content.includes(expenseEmoji)) {
                        return [];
                    }

                    // 解析记账记录
                    const fileRecords = this.parser.parseFileContent(content, file.path);

                    return fileRecords;
                } catch (error) {
                    console.error(`读取文件 ${file.path} 失败:`, error);
                    return [];
                }
            });

            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(fileRecords => {
                records.push(...fileRecords);
            });
        }
        return records.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }

    // 按日期范围筛选记录
    filterRecordsByDateRange(records: AccountingRecord[], startDate: string, endDate: string): AccountingRecord[] {
        return records.filter(record => {
            const recordDate = new Date(record.date);
            return recordDate >= new Date(startDate) && recordDate <= new Date(endDate);
        });
    }

    // 统计数据
    calculateStatistics(records: AccountingRecord[]): AccountingStats {
        const stats: AccountingStats = {
            totalIncome: 0,
            totalExpense: 0,
            categoryStats: {},
            dailyStats: {},
            budgetStatus: null // 新增预算状态
        };

        records.forEach(record => {
            if (record.isIncome) {
                stats.totalIncome += record.amount;
            } else {
                stats.totalExpense += record.amount;
            }

            // 分类统计
            if (!stats.categoryStats[record.category]) {
                stats.categoryStats[record.category] = {
                    total: 0,
                    count: 0,
                    records: []
                };
            }
            stats.categoryStats[record.category].total += record.amount;
            stats.categoryStats[record.category].count += 1;
            stats.categoryStats[record.category].records.push(record);

            // 日期统计
            if (!stats.dailyStats[record.date]) {
                stats.dailyStats[record.date] = {
                    income: 0,
                    expense: 0,
                    records: []
                };
            }
            if (record.isIncome) {
                stats.dailyStats[record.date].income += record.amount;
            } else {
                stats.dailyStats[record.date].expense += record.amount;
            }
            stats.dailyStats[record.date].records.push(record);
        });

        // 计算预算状态
        stats.budgetStatus = this.calculateBudgetStatus(stats);

        return stats;
    }
    
    // 计算预算状态
    calculateBudgetStatus(stats: AccountingStats): BudgetStatus | null {
        const budgets = this.config.budgets;
        if (!budgets || !budgets.enableAlerts) {
            return null;
        }
        
        const budgetStatus: BudgetStatus = {
            totalBudget: budgets.monthly.total,
            totalSpent: stats.totalExpense,
            totalRemaining: budgets.monthly.total - stats.totalExpense,
            totalProgress: budgets.monthly.total > 0 ? stats.totalExpense / budgets.monthly.total : 0,
            categories: {},
            alerts: []
        };
        
        // 检查总预算
        if (budgetStatus.totalProgress >= budgets.alertThreshold) {
            const alertType = budgetStatus.totalProgress >= 1 ? 'exceeded' : 'warning';
            budgetStatus.alerts.push({
                type: alertType,
                category: '总预算',
                message: alertType === 'exceeded' 
                    ? `总支出已超出预算 ¥${(stats.totalExpense - budgets.monthly.total).toFixed(2)}`
                    : `总支出已达预算的 ${(budgetStatus.totalProgress * 100).toFixed(0)}%`
            });
        }
        
        // 检查分类预算
        recordEntries(budgets.monthly.categories).forEach(([keyword, budget]) => {
            const categoryName = this.config.categories[keyword];
            if (!categoryName || budget <= 0) return;
            
            const spent = stats.categoryStats[categoryName]?.total || 0;
            const progress = spent / budget;
            const remaining = budget - spent;
            
            budgetStatus.categories[categoryName] = {
                budget,
                spent,
                remaining,
                progress,
                keyword
            };
            
            // 检查是否需要告警
            if (progress >= budgets.alertThreshold) {
                const alertType = progress >= 1 ? 'exceeded' : 'warning';
                budgetStatus.alerts.push({
                    type: alertType,
                    category: categoryName,
                    message: alertType === 'exceeded'
                        ? `${categoryName}支出已超出预算 ¥${(spent - budget).toFixed(2)}`
                        : `${categoryName}支出已达预算的 ${(progress * 100).toFixed(0)}%`
                });
            }
        });
        
        return budgetStatus;
    }
}

// 分类配置模态框
class CategoryConfigModal extends Modal {
    plugin: AccountingPlugin;
    appName: string;
    categories: Record<string, string>;
    budgets: AccountingConfig['budgets'];
    currentTab: string;
    contentArea: HTMLElement;
    categoryList: HTMLElement;
    budgetList: HTMLElement;

    constructor(app: App, plugin: AccountingPlugin) {
        super(app);
        this.plugin = plugin;
        this.appName = plugin.config.appName || '记账软件'; // 应用名称
        this.categories = { ...plugin.config.categories }; // 复制当前配置
        this.budgets = plugin.config.budgets ? { ...plugin.config.budgets } : {
            monthly: { total: 0, categories: {} },
            enableAlerts: true,
            alertThreshold: 0.8
        };
        this.currentTab = 'basic'; // 当前标签页，默认基础设置
    }

    onOpen() {
        // 使用自定义的应用名称作为标题
        const appName = this.plugin.config.appName || '每日记账';
        this.titleEl.setText(`${appName}配置`);
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('category-config-modal');

        // 标签页导航
        this.renderTabs(contentEl);
        
        // 内容区域
        this.contentArea = contentEl.createDiv('config-content');
        this.renderCurrentTab();

        // 按钮组
        const buttons = contentEl.createDiv('config-buttons');
        
        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'config-btn config-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();

        const saveBtn = buttons.createEl('button', {
            text: '保存',
            cls: 'config-btn config-btn-save'
        });
        saveBtn.onclick = () => this.saveConfig();
    }

    renderTabs(container: HTMLElement) {
        const tabsContainer = container.createDiv('config-tabs');
        
        const tabs = [
            { key: 'basic', label: '基础设置' },
            { key: 'categories', label: '分类管理' },
            { key: 'budgets', label: '预算设置' }
        ];
        
        tabs.forEach(tab => {
            const tabBtn = tabsContainer.createEl('button', {
                text: tab.label,
                cls: `config-tab ${this.currentTab === tab.key ? 'active' : ''}`
            });
            tabBtn.onclick = () => this.switchTab(tab.key);
        });
    }

    switchTab(tabKey: string) {
        this.currentTab = tabKey;
        
        // 更新标签按钮状态
        this.contentEl.querySelectorAll('.config-tab').forEach(btn => {
            btn.classList.remove('active');
        });
        const tabIndex = tabKey === 'basic' ? 1 : (tabKey === 'categories' ? 2 : 3);
        this.contentEl.querySelector(`.config-tab:nth-child(${tabIndex})`)!.classList.add('active');
        
        this.renderCurrentTab();
    }

    renderCurrentTab() {
        this.contentArea.empty();
        
        if (this.currentTab === 'basic') {
            this.renderBasicTab();
        } else if (this.currentTab === 'categories') {
            this.renderCategoriesTab();
        } else {
            this.renderBudgetsTab();
        }
    }

    renderBasicTab() {
        // 说明文字
        const description = this.contentArea.createDiv('config-description');
        description.createEl('p', { text: '自定义应用名称和默认分类，让记账软件更具个性化' });

        // 应用名称设置
        const nameSection = this.contentArea.createDiv('config-section');
        nameSection.createEl('h3', { text: '应用名称' });
        
        const nameGroup = nameSection.createDiv('config-input-group');
        nameGroup.createEl('label', { text: '显示名称：' });
        const nameInput = nameGroup.createEl('input', {
            type: 'text',
            cls: 'config-text-input',
            value: this.appName,
            attr: { placeholder: '记账软件', maxlength: '20' }
        });
        nameInput.oninput = () => {
            this.appName = nameInput.value.trim() || '每日记账';
        };

        // 默认分类设置
        const defaultCategorySection = this.contentArea.createDiv('config-section');
        defaultCategorySection.createEl('h3', { text: '默认分类' });
        
        const defaultCategoryGroup = defaultCategorySection.createDiv('config-input-group');
        defaultCategoryGroup.createEl('label', { text: '快速记账默认分类：' });
        
        const defaultCategorySelect = defaultCategoryGroup.createEl('select', {
            cls: 'config-select-input'
        });
        
        // 添加分类选项
        const currentDefault = this.plugin.config.defaultCategory || 'cy';
        recordEntries(this.categories).forEach(([keyword, categoryName]) => {
            const optEl = defaultCategorySelect.createEl('option', {
                value: keyword,
                text: `${categoryName} (${keyword})`
            });
            if (keyword === currentDefault) {
                optEl.selected = true;
            }
        });


        // 预览效果
        const previewSection = this.contentArea.createDiv('config-section');
        previewSection.createEl('h3', { text: '预览效果' });
        
        const previewBox = previewSection.createDiv('config-preview-box');
        const previewTitle = previewBox.createDiv({
            cls: 'preview-title'
        });
        
        const updatePreview = () => {
            previewTitle.textContent = `💰 ${this.appName}`;
        };
        
        updatePreview();
        nameInput.oninput = () => {
            this.appName = nameInput.value.trim() || '记账软件';
            updatePreview();
        };
    }

    renderCategoriesTab() {
        // 说明文字
        const description = this.contentArea.createDiv('config-description');
        description.createEl('p', { text: '配置记账关键词和对应的分类名称' });
        const note = description.createEl('p');
        note.createEl('strong', { text: '注意：' });
        note.appendText(' ');
        note.createEl('code', { text: 'Sr' });
        note.appendText(' 关键词表示收入，其他为支出');

        // 分类列表
        this.categoryList = this.contentArea.createDiv('category-list');
        this.renderCategoryList();

        // 添加新分类按钮
        const addButton = this.contentArea.createEl('button', {
            text: '+ 添加新分类',
            cls: 'add-category-btn'
        });
        addButton.onclick = () => this.addNewCategory();
    }

    renderBudgetsTab() {
        // 说明文字
        const description = this.contentArea.createDiv('config-description');
        description.createEl('p', { text: '设置月度预算限额，系统会在接近或超出预算时提醒' });
        const tip = description.createEl('p');
        tip.createEl('strong', { text: '提示：' });
        tip.appendText(' 设置为 0 表示不限制该分类预算');

        // 预算开关
        const alertSection = this.contentArea.createDiv('budget-section');
        alertSection.createEl('h3', { text: '预算提醒设置' });
        
        const alertToggle = alertSection.createDiv('budget-toggle');
        const enableCheckbox = alertToggle.createEl('input', { type: 'checkbox' });
        enableCheckbox.checked = this.budgets.enableAlerts;
        enableCheckbox.onchange = () => {
            this.budgets.enableAlerts = enableCheckbox.checked;
        };
        alertToggle.createSpan({ text: '启用预算告警' });

        // 告警阈值
        const thresholdSection = alertSection.createDiv('threshold-section');
        thresholdSection.createEl('label', { text: '告警阈值 (%)：' });
        const thresholdInput = thresholdSection.createEl('input', {
            type: 'number',
            value: (this.budgets.alertThreshold * 100).toString(),
            attr: { min: '50', max: '100', step: '5' }
        });
        thresholdInput.onchange = () => {
            this.budgets.alertThreshold = parseInt(thresholdInput.value) / 100;
        };

        // 总预算
        const totalSection = this.contentArea.createDiv('budget-section');
        totalSection.createEl('h3', { text: '月度总预算' });
        const totalInput = totalSection.createEl('input', {
            type: 'number',
            cls: 'budget-input total-budget',
            value: this.budgets.monthly.total.toString(),
            attr: { placeholder: '月度总预算', min: '0', step: '100' }
        });
        totalInput.onchange = () => {
            this.budgets.monthly.total = parseFloat(totalInput.value) || 0;
        };

        // 分类预算
        const categorySection = this.contentArea.createDiv('budget-section');
        categorySection.createEl('h3', { text: '分类预算' });
        
        this.budgetList = categorySection.createDiv('budget-list');
        this.renderBudgetList();
    }

    renderBudgetList() {
        this.budgetList.empty();

        recordEntries(this.categories).forEach(([keyword, categoryName]) => {
            if (keyword === 'sr') return; // 跳过收入分类
            
            const item = this.budgetList.createDiv('budget-item');
            
            const label = item.createDiv('budget-label');
            label.textContent = `${categoryName} (${keyword})`;
            
            const input = item.createEl('input', {
                type: 'number',
                cls: 'budget-input',
                value: (this.budgets.monthly.categories[keyword] || 0).toString(),
                attr: { placeholder: '预算金额', min: '0', step: '50' }
            });
            
            input.onchange = () => {
                const value = parseFloat(input.value) || 0;
                if (value > 0) {
                    this.budgets.monthly.categories[keyword] = value;
                } else {
                    delete this.budgets.monthly.categories[keyword];
                }
            };
        });
    }

    renderCategoryList() {
        this.categoryList.empty();

        recordEntries(this.categories).forEach(([keyword, category]) => {
            const item = this.categoryList.createDiv('category-item');
            
            const keywordInput = item.createEl('input', {
                type: 'text',
                cls: 'category-keyword',
                value: keyword,
                placeholder: '关键词'
            });
            keywordInput.maxLength = 10;

            const categoryInput = item.createEl('input', {
                type: 'text',
                cls: 'category-name',
                value: category,
                placeholder: '分类名称'
            });
            categoryInput.maxLength = 20;

            const deleteBtn = item.createEl('button', {
                text: '删除',
                cls: 'delete-category-btn'
            });
            deleteBtn.onclick = () => this.deleteCategory(keyword);
        });
    }

    addNewCategory() {
        const newKeyword = `new${Date.now()}`;
        this.categories[newKeyword] = '新分类';
        this.renderCategoryList();
    }

    deleteCategory(keyword: string) {
        delete this.categories[keyword];
        // 同时删除对应的预算设置
        delete this.budgets.monthly.categories[keyword];
        this.renderCategoryList();
        if (this.currentTab === 'budgets') {
            this.renderBudgetList();
        }
    }

    updateCategory(oldKeyword: string, newKeyword: string, categoryName: string) {
        if (oldKeyword !== newKeyword) {
            delete this.categories[oldKeyword];
            // 更新预算设置中的关键词
            if (this.budgets.monthly.categories[oldKeyword]) {
                this.budgets.monthly.categories[newKeyword] = this.budgets.monthly.categories[oldKeyword];
                delete this.budgets.monthly.categories[oldKeyword];
            }
        }
        this.categories[newKeyword] = categoryName;
    }

    async saveConfig() {
        try {
            // 验证应用名称
            const cleanAppName = this.appName.trim();
            if (!cleanAppName) {
                new Notice('应用名称不能为空');
                return;
            }

            // 验证分类配置：优先从 DOM 读取（分类 tab 已渲染时），否则用内存副本
            const cleanCategories: Record<string, string> = {};
            if (this.categoryList) {
                const categoryItems = this.categoryList.querySelectorAll('.category-item');
                categoryItems.forEach((item) => {
                    const keywordInput = item.querySelector('.category-keyword') as HTMLInputElement;
                    const nameInput = item.querySelector('.category-name') as HTMLInputElement;
                    const cleanKeyword = keywordInput?.value.trim();
                    const cleanCategory = nameInput?.value.trim();
                    if (cleanKeyword && cleanCategory) {
                        cleanCategories[cleanKeyword] = cleanCategory;
                    }
                });
            } else {
                // 分类 tab 未渲染，直接用内存副本
                Object.assign(cleanCategories, this.categories);
            }

            if (Object.keys(cleanCategories).length === 0) {
                new Notice('至少需要一个分类');
                return;
            }

            // 获取默认分类选择
            const defaultCategorySelect = this.contentEl.querySelector('.config-select-input') as HTMLSelectElement;
            const defaultCategory = defaultCategorySelect ? defaultCategorySelect.value : (this.plugin.config.defaultCategory || 'cy');

            // 更新配置
            this.plugin.config.appName = cleanAppName;
            this.plugin.config.categories = cleanCategories;
            this.plugin.config.defaultCategory = defaultCategory;
            this.plugin.config.budgets = this.budgets;
            
            // 保存到文件
            const configPath = `${this.plugin.manifest.dir}/config.json`;
            const adapter = this.app.vault.adapter;
            const configContent = JSON.stringify(this.plugin.config, null, 4);
            await adapter.write(configPath, configContent);

            // 清除缓存，重新加载数据
            this.plugin.storage.clearCache();
            
            this.close();
            
            // 关闭并重新打开视图以刷新标题
            const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
            for (const leaf of leaves) {
                // 先分离视图
                await leaf.setViewState({ type: 'empty' });
            }
            
            // 等待一小段时间后重新打开
            window.setTimeout(() => {
                void this.plugin.activateView();
            }, 100);
        } catch (error) {
            console.error('保存配置失败:', error);
            new Notice('保存配置失败');
        }
    }
}
class DateRangeModal extends Modal {
    options: DateRangeModalOptions;
    startInput: HTMLInputElement;
    endInput: HTMLInputElement;

    constructor(app: App, options: DateRangeModalOptions) {
        super(app);
        this.options = options;
    }

    onOpen() {
        this.titleEl.setText('选择查询时间范围');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('date-range-modal');

        // 开始日期
        const startGroup = contentEl.createDiv('date-group');
        startGroup.createEl('label', { text: '开始日期:' });
        this.startInput = startGroup.createEl('input', {
            type: 'date',
            cls: 'date-input'
        });
        
        // 结束日期
        const endGroup = contentEl.createDiv('date-group');
        endGroup.createEl('label', { text: '结束日期:' });
        this.endInput = endGroup.createEl('input', {
            type: 'date',
            cls: 'date-input'
        });

        // 设置默认值：本月1号到今天
        const today = new Date();
        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        
        // 使用本地日期格式，避免时区问题
        this.startInput.value = formatLocalDate(firstDayOfMonth);
        this.endInput.value = formatLocalDate(today);

        // 按钮
        const buttons = contentEl.createDiv('date-buttons');
        
        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'date-btn date-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();

        const confirmBtn = buttons.createEl('button', {
            text: '确定',
            cls: 'date-btn date-btn-confirm'
        });
        confirmBtn.onclick = () => {
            const startDate = this.startInput.value;
            const endDate = this.endInput.value;
            
            if (startDate && endDate) {
                this.options.onSelect(startDate, endDate);
                this.close();
            } else {
                new Notice('请选择完整的日期范围');
            }
        };
    }

    formatDate(date: Date): string {
        // 使用本地时区格式化日期，避免 UTC 时区问题
        return formatLocalDate(date);
    }
}

class ConfirmOverwriteModal extends Modal {
    filePath: string;
    onConfirm: () => Promise<void>;

    constructor(app: App, filePath: string, onConfirm: () => Promise<void>) {
        super(app);
        this.filePath = filePath;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        this.titleEl.setText('确认覆盖');
        contentEl.createEl('p', { text: `文件 "${this.filePath}" 已存在，是否覆盖？` });
        const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
        const confirmBtn = buttons.createEl('button', { text: '覆盖', cls: 'mod-cta' });
        confirmBtn.onclick = () => {
            void this.onConfirm();
            this.close();
        };
        buttons.createEl('button', { text: '取消' }).onclick = () => this.close();
    }
}

/** 删除单条记账记录的确认框（长按记录或右键菜单触发） */
class ConfirmDeleteRecordModal extends Modal {
    record: AccountingRecord;
    filePath: string;
    onConfirm: () => Promise<void>;

    constructor(app: App, record: AccountingRecord, filePath: string, onConfirm: () => Promise<void>) {
        super(app);
        this.record = record;
        this.filePath = filePath;
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('delete-record-modal');
        this.titleEl.setText('删除记账记录');

        // 记录预览，避免误删
        const preview = contentEl.createDiv('delete-record-preview');
        preview.createSpan({ text: this.record.category, cls: 'delete-record-category' });
        preview.createSpan({
            text: this.record.description || '（无描述）',
            cls: 'delete-record-desc'
        });
        preview.createSpan({
            text: this.record.isIncome ? `+¥${this.record.amount}` : `-¥${this.record.amount}`,
            cls: `delete-record-amount ${this.record.isIncome ? 'income' : 'expense'}`
        });

        contentEl.createEl('p', {
            text: `将从 ${this.filePath} 中删除这一行，删除后可用 Obsidian 的撤销或文件历史恢复。`,
            cls: 'record-modal-hint'
        });

        const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
        const confirmBtn = buttons.createEl('button', { text: '删除', cls: 'mod-warning' });
        confirmBtn.onclick = () => {
            void this.onConfirm();
            this.close();
        };
        buttons.createEl('button', { text: '取消' }).onclick = () => this.close();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

// Markdown 导出模态框
class MarkdownExportModal extends Modal {
    markdown: string;
    fileName: string;
    folders: string[];
    selectedFolder: string;
    fileNameInput: HTMLInputElement;

    constructor(app: App, markdown: string, fileName: string) {
        super(app);
        this.markdown = markdown;
        this.fileName = fileName;
        this.folders = this.getAllFolders();
        this.selectedFolder = this.folders[0] || '/';
    }

    getAllFolders(): string[] {
        const folders: string[] = ['/'];  // 根目录
        const allFiles = this.app.vault.getAllLoadedFiles();

        allFiles.forEach((file: TAbstractFile) => {
            if (file instanceof TFolder) {  // 是文件夹
                folders.push(file.path);
            }
        });

        return folders.sort();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('markdown-export-modal');

        this.titleEl.setText('导出 Markdown');

        // 保存设置区域
        const saveSection = contentEl.createDiv('export-save-section');
        
        // 文件夹选择
        const folderGroup = saveSection.createDiv('export-input-group');
        folderGroup.createEl('label', { text: '保存位置：', cls: 'export-label' });
        
        const folderSelect = folderGroup.createEl('select', {
            cls: 'export-folder-select'
        });
        
        this.folders.forEach(folder => {
            folderSelect.createEl('option', {
                value: folder,
                text: folder === '/' ? '/ (根目录)' : folder
            });
        });
        
        folderSelect.onchange = () => {
            this.selectedFolder = folderSelect.value;
        };

        // 文件名输入
        const fileNameGroup = saveSection.createDiv('export-input-group');
        fileNameGroup.createEl('label', { text: '文件名：', cls: 'export-label' });
        
        const fileNameWrapper = fileNameGroup.createDiv('export-filename-wrapper');
        this.fileNameInput = fileNameWrapper.createEl('input', {
            type: 'text',
            cls: 'export-filename-input',
            value: this.fileName,
            attr: { placeholder: '输入文件名' }
        });
        fileNameWrapper.createSpan({ text: '.md', cls: 'export-filename-ext' });

        // 预览区域
        const previewSection = contentEl.createDiv('markdown-preview-section');
        previewSection.createEl('label', { text: '预览：', cls: 'export-label' });
        
        const previewContainer = previewSection.createEl('textarea', {
            cls: 'markdown-preview-textarea',
            attr: { readonly: 'true', rows: '15' }
        });
        previewContainer.value = this.markdown;

        // 按钮组
        const buttons = contentEl.createDiv('export-buttons');
        
        const copyBtn = buttons.createEl('button', {
            text: '复制到剪贴板',
            cls: 'export-btn export-btn-cancel'
        });
        copyBtn.onclick = async () => {
            await navigator.clipboard.writeText(this.markdown);
            new Notice('已复制到剪贴板');
        };

        const saveBtn = buttons.createEl('button', {
            text: '保存文件',
            cls: 'export-btn export-btn-export'
        });
        saveBtn.onclick = () => this.saveFile();
    }

    async saveFile() {
        try {
            const fileName = this.fileNameInput.value.trim();
            if (!fileName) {
                new Notice('请输入文件名');
                return;
            }

            // 构建完整路径
            let filePath: string;
            if (this.selectedFolder === '/') {
                filePath = `${fileName}.md`;
            } else {
                filePath = `${this.selectedFolder}/${fileName}.md`;
            }

            // 检查文件是否存在
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);

            if (existingFile instanceof TFile) {
                // 文件存在，用模态框询问是否覆盖
                new ConfirmOverwriteModal(this.app, filePath, async () => {
                    await this.app.vault.modify(existingFile, this.markdown);
                    new Notice(`已保存到: ${filePath}`);
                    this.close();
                    const savedFile = this.app.vault.getAbstractFileByPath(filePath);
                    if (savedFile instanceof TFile) {
                        const leaf = this.app.workspace.getLeaf();
                        await leaf.openFile(savedFile);
                    }
                }).open();
                return;
            } else {
                // 创建新文件
                await this.app.vault.create(filePath, this.markdown);
            }

            new Notice(`已保存到: ${filePath}`);
            this.close();

            // 打开保存的文件
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                const leaf = this.app.workspace.getLeaf();
                await leaf.openFile(file);
            }
        } catch (error) {
            console.error('保存文件失败:', error);
            new Notice('保存失败，请检查文件名是否有效');
        }
    }
}

interface PdfExportPage {
    content: HTMLElement;
}

interface PdfTableChunk {
    element: HTMLElement;
    tbody: HTMLTableSectionElement;
}

const PDF_PAGE_WIDTH_PX = 720;
const PDF_PAGE_HEIGHT_PX = Math.floor(PDF_PAGE_WIDTH_PX * 297 / 210);
const PDF_RENDER_SCALE = 2;

// PDF 导出模态框
class ExportPDFModal extends Modal {
    plugin: AccountingPlugin;
    records: AccountingRecord[];
    stats: AccountingStats;
    dateRange: { start: string; end: string; label: string };

    constructor(app: App, plugin: AccountingPlugin, records: AccountingRecord[], stats: AccountingStats, dateRange: { start: string; end: string; label: string }) {
        super(app);
        this.plugin = plugin;
        this.records = records;
        this.stats = stats;
        this.dateRange = dateRange;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('export-pdf-modal');

        this.titleEl.setText('导出账单 PDF');

        // 预览区域
        const previewSection = contentEl.createDiv('export-preview-section');
        previewSection.createEl('label', { text: '预览', cls: 'export-label' });
        
        const previewContainer = previewSection.createDiv('export-preview-container');
        this.generatePDFContent(previewContainer);
        
        // 按钮组
        const buttons = contentEl.createDiv('export-buttons');
        
        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'export-btn export-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();
        
        const exportBtn = buttons.createEl('button', {
            text: '导出 PDF',
            cls: 'export-btn export-btn-export'
        });
        exportBtn.onclick = () => this.exportToPDF();
    }

    generatePDFContent(container: HTMLElement): HTMLElement {
        const content = container.createDiv('pdf-content');
        const intro = content.createDiv('pdf-export-intro');

        // 标题
        const appName = this.plugin.config.appName || '每日记账';
        intro.createEl('h1', {
            text: `${appName} - 账单报告`,
            cls: 'pdf-title'
        });

        // 时间范围
        intro.createEl('p', {
            text: `时间范围: ${this.dateRange.label} (${this.dateRange.start} 至 ${this.dateRange.end})`,
            cls: 'pdf-date-range'
        });

        intro.createEl('p', {
            text: `导出时间: ${formatLocalDate(new Date())} ${new Date().toLocaleTimeString('zh-CN')}`,
            cls: 'pdf-export-time'
        });

        // 统计概览
        const statsSection = intro.createDiv('pdf-stats-section');
        statsSection.createEl('h2', { text: '统计概览' });
        
        const statsGrid = statsSection.createDiv('pdf-stats-grid');
        
        const { totalIncome, totalExpense } = this.stats;
        const balance = totalIncome - totalExpense;
        
        // 收入
        const incomeCard = statsGrid.createDiv('pdf-stat-card income');
        incomeCard.createDiv({ text: '总收入', cls: 'pdf-stat-label' });
        incomeCard.createDiv({ text: `¥${totalIncome.toFixed(2)}`, cls: 'pdf-stat-value' });
        
        // 支出
        const expenseCard = statsGrid.createDiv('pdf-stat-card expense');
        expenseCard.createDiv({ text: '总支出', cls: 'pdf-stat-label' });
        expenseCard.createDiv({ text: `¥${totalExpense.toFixed(2)}`, cls: 'pdf-stat-value' });
        
        // 结余
        const balanceCard = statsGrid.createDiv(`pdf-stat-card ${balance >= 0 ? 'positive' : 'negative'}`);
        balanceCard.createDiv({ text: '结余', cls: 'pdf-stat-label' });
        balanceCard.createDiv({ text: `¥${balance.toFixed(2)}`, cls: 'pdf-stat-value' });

        // 分类统计
        if (Object.keys(this.stats.categoryStats).length > 0) {
            const categorySection = content.createDiv('pdf-category-section');
            categorySection.createEl('h2', { text: '分类统计' });
            
            const categoryTable = categorySection.createEl('table', { cls: 'pdf-table' });
            const thead = categoryTable.createEl('thead');
            const headerRow = thead.createEl('tr');
            headerRow.createEl('th', { text: '分类' });
            headerRow.createEl('th', { text: '金额' });
            headerRow.createEl('th', { text: '笔数' });
            headerRow.createEl('th', { text: '占比' });
            
            const tbody = categoryTable.createEl('tbody');
            
            // 计算总支出用于占比
            const totalForPercentage = totalExpense > 0 ? totalExpense : 1;
            
            categoryStatEntries(this.stats.categoryStats)
                .sort(([,a], [,b]) => b.total - a.total)
                .forEach(([category, data]) => {
                    const row = tbody.createEl('tr');
                    row.createEl('td', { text: category });
                    row.createEl('td', { text: `¥${data.total.toFixed(2)}` });
                    row.createEl('td', { text: `${data.count} 笔` });
                    
                    // 收入类别不计算占比
                    const isIncome = data.records.some(r => r.isIncome);
                    const percentage = isIncome ? '-' : `${((data.total / totalForPercentage) * 100).toFixed(1)}%`;
                    row.createEl('td', { text: percentage });
                });
        }

        // 详细记录
        const recordsSection = content.createDiv('pdf-records-section');
        recordsSection.createEl('h2', { text: `详细记录 (共 ${this.records.length} 笔)` });
        
        // 按日期分组
        const groupedRecords = this.groupRecordsByDate(this.records);
        
        recordEntries(groupedRecords)
            .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
            .forEach(([date, dayRecords]) => {
                const dayGroup = recordsSection.createDiv('pdf-day-group');
                
                // 日期头部
                const dayHeader = dayGroup.createDiv('pdf-day-header');
                const dayTotal = dayRecords.reduce((sum, r) => sum + (r.isIncome ? r.amount : -r.amount), 0);
                dayHeader.createSpan({ text: date, cls: 'pdf-day-date' });
                dayHeader.createSpan({ 
                    text: `¥${dayTotal.toFixed(2)}`, 
                    cls: `pdf-day-total ${dayTotal >= 0 ? 'positive' : 'negative'}`
                });
                
                // 日期下的记录表格
                const dayTable = dayGroup.createEl('table', { cls: 'pdf-table pdf-day-table' });
                const dayTbody = dayTable.createEl('tbody');
                
                dayRecords.forEach(record => {
                    const row = dayTbody.createEl('tr');
                    row.dataset.pdfRecord = 'true';
                    row.createEl('td', { text: record.category, cls: 'pdf-record-category' });
                    row.createEl('td', { text: record.description || '-', cls: 'pdf-record-desc' });
                    
                    const amountCell = row.createEl('td', { cls: 'pdf-record-amount' });
                    amountCell.textContent = record.isIncome ? `+¥${record.amount}` : `-¥${record.amount}`;
                    amountCell.classList.add(record.isIncome ? 'income' : 'expense');
                });
            });

        return content;
    }

    groupRecordsByDate(records: AccountingRecord[]): Record<string, AccountingRecord[]> {
        const grouped: Record<string, AccountingRecord[]> = {};
        records.forEach(record => {
            if (!grouped[record.date]) {
                grouped[record.date] = [];
            }
            grouped[record.date].push(record);
        });
        return grouped;
    }

    private requireElement<T extends Element>(root: ParentNode, selector: string): T {
        const element = root.querySelector<T>(selector);
        if (!element) {
            throw new Error(`PDF 内容缺少元素: ${selector}`);
        }
        return element;
    }

    private cloneElement(element: HTMLElement): HTMLElement {
        return element.cloneNode(true) as HTMLElement;
    }

    private async waitForPDFLayout(root: HTMLElement): Promise<void> {
        const ownerDoc = root.ownerDocument;
        await ownerDoc.fonts.ready;
        await Promise.all(
            Array.from(root.querySelectorAll('img')).map(image => image.decode().catch(() => undefined))
        );

        const ownerWindow = ownerDoc.defaultView;
        if (!ownerWindow) {
            throw new Error('无法获取 PDF 渲染窗口');
        }

        const nextFrame = () => new Promise<void>(resolve => ownerWindow.requestAnimationFrame(() => resolve()));
        await nextFrame();
        await nextFrame();
    }

    private createPDFPage(container: HTMLElement): PdfExportPage {
        const page = container.createDiv('pdf-export-page');
        const content = page.createDiv('pdf-content pdf-export-page-content');
        return { content };
    }

    private pageOverflows(page: PdfExportPage): boolean {
        return page.content.scrollHeight > page.content.clientHeight;
    }

    private appendWholeBlock(source: HTMLElement, currentPage: PdfExportPage, pagesContainer: HTMLElement): PdfExportPage {
        let page = currentPage;
        let clone = this.cloneElement(source);
        page.content.appendChild(clone);
        if (!this.pageOverflows(page)) {
            return page;
        }

        clone.remove();
        if (page.content.childElementCount > 0) {
            page = this.createPDFPage(pagesContainer);
        }

        clone = this.cloneElement(source);
        page.content.appendChild(clone);
        if (this.pageOverflows(page)) {
            throw new Error('PDF 内容块超过单页高度');
        }
        return page;
    }

    private createCategoryChunk(source: HTMLElement, continued: boolean): PdfTableChunk {
        const element = this.cloneElement(source);
        const tbody = this.requireElement<HTMLTableSectionElement>(element, 'tbody');
        tbody.empty();
        if (continued) {
            this.requireElement<HTMLElement>(element, 'h2').setText('分类统计（续）');
        }
        return { element, tbody };
    }

    private appendCategorySection(source: HTMLElement, currentPage: PdfExportPage, pagesContainer: HTMLElement): PdfExportPage {
        let page = currentPage;
        let wholeSection = this.cloneElement(source);
        page.content.appendChild(wholeSection);
        if (!this.pageOverflows(page)) {
            return page;
        }

        wholeSection.remove();
        if (page.content.childElementCount > 0) {
            page = this.createPDFPage(pagesContainer);
            wholeSection = this.cloneElement(source);
            page.content.appendChild(wholeSection);
            if (!this.pageOverflows(page)) {
                return page;
            }
            wholeSection.remove();
        }

        const sourceRows = Array.from(source.querySelectorAll<HTMLTableRowElement>('tbody > tr'));
        let chunk = this.createCategoryChunk(source, false);
        page.content.appendChild(chunk.element);

        sourceRows.forEach(sourceRow => {
            let row = this.cloneElement(sourceRow);
            chunk.tbody.appendChild(row);
            if (!this.pageOverflows(page)) {
                return;
            }

            row.remove();
            if (chunk.tbody.childElementCount === 0) {
                throw new Error('分类统计中的单行内容超过单页高度');
            }

            page = this.createPDFPage(pagesContainer);
            chunk = this.createCategoryChunk(source, true);
            page.content.appendChild(chunk.element);
            row = this.cloneElement(sourceRow);
            chunk.tbody.appendChild(row);
            if (this.pageOverflows(page)) {
                throw new Error('分类统计中的单行内容超过单页高度');
            }
        });

        return page;
    }

    private createRecordsPageSection(source: HTMLElement, continued: boolean): HTMLElement {
        const section = source.cloneNode(false) as HTMLElement;
        if (!continued) {
            const heading = this.cloneElement(this.requireElement<HTMLElement>(source, ':scope > h2'));
            section.appendChild(heading);
        }
        return section;
    }

    private createDayGroupChunk(source: HTMLElement, continued: boolean): PdfTableChunk {
        const element = this.cloneElement(source);
        const tbody = this.requireElement<HTMLTableSectionElement>(element, 'tbody');
        tbody.empty();
        if (continued) {
            const date = this.requireElement<HTMLElement>(element, '.pdf-day-date');
            date.setText(`${date.textContent ?? ''}（续）`);
        }
        return { element, tbody };
    }

    private appendRecordsSection(source: HTMLElement, currentPage: PdfExportPage, pagesContainer: HTMLElement): void {
        const sourceGroups = Array.from(source.querySelectorAll<HTMLElement>(':scope > .pdf-day-group'));
        let page = currentPage;
        let section = this.createRecordsPageSection(source, false);
        let groupsOnPage = 0;
        let placedRecords = 0;
        page.content.appendChild(section);

        const startRecordsPage = (continued: boolean) => {
            page = this.createPDFPage(pagesContainer);
            section = this.createRecordsPageSection(source, continued);
            groupsOnPage = 0;
            page.content.appendChild(section);
        };

        if (sourceGroups.length === 0) {
            if (this.pageOverflows(page)) {
                section.remove();
                startRecordsPage(false);
            }
            return;
        }

        sourceGroups.forEach(sourceGroup => {
            const sourceRows = Array.from(sourceGroup.querySelectorAll<HTMLTableRowElement>('tbody > tr'));
            let wholeGroup = this.cloneElement(sourceGroup);
            section.appendChild(wholeGroup);

            if (!this.pageOverflows(page)) {
                groupsOnPage += 1;
                placedRecords += sourceRows.length;
                return;
            }

            wholeGroup.remove();
            if (groupsOnPage > 0) {
                startRecordsPage(true);
            } else if (page.content.childElementCount > 1) {
                section.remove();
                startRecordsPage(placedRecords > 0);
            }

            wholeGroup = this.cloneElement(sourceGroup);
            section.appendChild(wholeGroup);
            if (!this.pageOverflows(page)) {
                groupsOnPage += 1;
                placedRecords += sourceRows.length;
                return;
            }
            wholeGroup.remove();

            let chunk = this.createDayGroupChunk(sourceGroup, false);
            section.appendChild(chunk.element);

            sourceRows.forEach(sourceRow => {
                let row = this.cloneElement(sourceRow);
                chunk.tbody.appendChild(row);
                if (this.pageOverflows(page)) {
                    row.remove();
                    if (chunk.tbody.childElementCount === 0) {
                        throw new Error('单条账目内容超过单页高度');
                    }

                    groupsOnPage += 1;
                    startRecordsPage(true);
                    chunk = this.createDayGroupChunk(sourceGroup, true);
                    section.appendChild(chunk.element);
                    row = this.cloneElement(sourceRow);
                    chunk.tbody.appendChild(row);
                    if (this.pageOverflows(page)) {
                        throw new Error('单条账目内容超过单页高度');
                    }
                }
                placedRecords += 1;
            });
            groupsOnPage += 1;
        });

        if (placedRecords !== this.records.length) {
            throw new Error(`PDF 分页记录数不一致: ${placedRecords}/${this.records.length}`);
        }
    }

    private async createPDFPages(renderHost: HTMLElement): Promise<HTMLElement[]> {
        const sourceContainer = renderHost.createDiv('pdf-export-source');
        const sourceContent = this.generatePDFContent(sourceContainer);
        await this.waitForPDFLayout(sourceContainer);

        const pagesContainer = renderHost.createDiv('pdf-export-pages');
        let page = this.createPDFPage(pagesContainer);

        const intro = this.requireElement<HTMLElement>(sourceContent, ':scope > .pdf-export-intro');
        page = this.appendWholeBlock(intro, page, pagesContainer);

        const categorySection = sourceContent.querySelector<HTMLElement>(':scope > .pdf-category-section');
        if (categorySection) {
            page = this.appendCategorySection(categorySection, page, pagesContainer);
        }

        const recordsSection = this.requireElement<HTMLElement>(sourceContent, ':scope > .pdf-records-section');
        this.appendRecordsSection(recordsSection, page, pagesContainer);
        sourceContainer.remove();
        await this.waitForPDFLayout(pagesContainer);

        const pages = Array.from(pagesContainer.querySelectorAll<HTMLElement>(':scope > .pdf-export-page'));
        if (pages.length === 0) {
            throw new Error('没有生成 PDF 页面');
        }

        pages.forEach((pageElement, index) => {
            const content = this.requireElement<HTMLElement>(pageElement, ':scope > .pdf-export-page-content');
            if (content.scrollHeight > content.clientHeight) {
                throw new Error(`PDF 第 ${index + 1} 页内容溢出`);
            }
        });

        const renderedRecordCount = pagesContainer.querySelectorAll('[data-pdf-record="true"]').length;
        if (renderedRecordCount !== this.records.length) {
            throw new Error(`PDF 页面记录数不一致: ${renderedRecordCount}/${this.records.length}`);
        }
        return pages;
    }

    async exportToPDF() {
        let renderHost: HTMLElement | null = null;
        try {
            new Notice('正在生成 PDF...');

            const ownerDoc = this.contentEl.ownerDocument;
            renderHost = ownerDoc.body.createDiv('pdf-export-render-host');
            const pages = await this.createPDFPages(renderHost);
            const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

            for (let index = 0; index < pages.length; index += 1) {
                const canvas = await html2canvas(pages[index], {
                    scale: PDF_RENDER_SCALE,
                    useCORS: true,
                    logging: false,
                    backgroundColor: '#ffffff',
                    width: PDF_PAGE_WIDTH_PX,
                    height: PDF_PAGE_HEIGHT_PX,
                    windowWidth: PDF_PAGE_WIDTH_PX,
                    windowHeight: PDF_PAGE_HEIGHT_PX,
                    scrollX: 0,
                    scrollY: 0
                });

                try {
                    if (index > 0) {
                        pdf.addPage();
                    }
                    pdf.addImage(canvas, 'PNG', 0, 0, 210, 297, `page-${index + 1}`, 'FAST');
                } finally {
                    canvas.width = 0;
                    canvas.height = 0;
                }
            }

            const appName = this.plugin.config.appName || '每日记账';
            const fileName = `${buildExportFileName(appName, this.dateRange.start, this.dateRange.end)}.pdf`;
            pdf.save(fileName);

            new Notice(`PDF 已保存: ${fileName}`);
            this.close();
        } catch (error) {
            console.error('导出 PDF 失败:', error);
            new Notice('导出 PDF 失败，请重试');
        } finally {
            renderHost?.remove();
        }
    }

}

/** 复用快速记账弹窗编辑已有记录时的上下文，为空表示新增记账 */
interface QuickEntryEditTarget {
    record: AccountingRecord;
    onUpdate: (keyword: string, description: string, amount: number) => Promise<void>;
}

// 快速记账模态框（editTarget 非空时复用同一表单编辑已有记录）
class QuickEntryModal extends Modal {
    plugin: AccountingPlugin;
    onSave: () => Promise<void>;
    selectedCategory: string | null;
    amount: string;
    description: string;
    amountInput: HTMLInputElement;
    editTarget: QuickEntryEditTarget | null;

    constructor(
        app: App,
        plugin: AccountingPlugin,
        onSave: () => Promise<void>,
        editTarget: QuickEntryEditTarget | null = null
    ) {
        super(app);
        this.plugin = plugin;
        this.onSave = onSave;
        this.selectedCategory = null;
        this.amount = '';
        this.description = '';
        this.editTarget = editTarget;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('quick-entry-modal');
        this.containerEl.addClass('quick-entry-container');

        this.titleEl.setText(this.editTarget ? '编辑记账记录' : '快速记账');

        // 分类选择
        const categorySection = contentEl.createDiv('entry-section');
        categorySection.createEl('label', { text: '选择分类', cls: 'entry-label' });
        
        const categoryGrid = categorySection.createDiv('category-grid');
        
        // 编辑时预选记录原分类，新增时用默认分类
        const defaultCategory = this.editTarget
            ? this.editTarget.record.keyword
            : (this.plugin.config.defaultCategory || 'cy');
        
        // 创建分类按钮
        recordEntries(this.plugin.config.categories).forEach(([keyword, categoryName]) => {
            const isIncome = keyword === 'sr';
            const btn = categoryGrid.createEl('button', {
                text: categoryName,
                cls: `category-btn ${isIncome ? 'income-btn' : 'expense-btn'}`
            });
            btn.setAttribute('data-keyword', keyword);
            btn.onclick = () => this.selectCategory(keyword, btn);
            
            // 自动选中默认分类
            if (keyword === defaultCategory) {
                btn.classList.add('selected');
                this.selectedCategory = keyword;
            }
        });

        // 金额和备注输入（合并为一个输入框）
        const amountSection = contentEl.createDiv('entry-section');
        const label = amountSection.createEl('label', { text: '金额和备注', cls: 'entry-label' });
        
        // 根据设备类型显示不同提示
        const isMobile = window.innerWidth <= 600;
        const hintText = isMobile 
            ? '（格式：50 午餐，回车保存）'
            : '（格式：金额 备注，如：50 午餐）';
        
        label.createSpan({
            text: hintText,
            cls: 'entry-hint'
        });
        
        this.amountInput = amountSection.createEl('input', {
            type: 'text',
            cls: 'entry-input entry-input-combined',
            attr: { 
                placeholder: '例如：50 午餐 或 50',
                maxlength: '100',
                inputmode: 'text' // 优化移动端输入法
            }
        });

        // 编辑模式回填原有金额和备注
        if (this.editTarget) {
            const { amount, description } = this.editTarget.record;
            this.amountInput.value = description ? `${amount} ${description}` : `${amount}`;
        }

        // 按钮组（放在输入框后面，但在移动端会通过CSS调整顺序）
        const buttons = contentEl.createDiv('entry-buttons');
        
        const saveBtn = buttons.createEl('button', {
            text: '保存',
            cls: 'entry-btn entry-btn-save'
        });
        saveBtn.onclick = () => this.saveEntry();
        
        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'entry-btn entry-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();

        // 回车保存
        this.amountInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                void this.saveEntry();
            }
        });
        
        // 延迟聚焦，避免立即弹出输入法
        window.setTimeout(() => {
            this.amountInput.focus();
        }, 100);
    }

    selectCategory(keyword: string, buttonEl: HTMLElement) {
        // 清除其他按钮的选中状态
        this.contentEl.querySelectorAll('.category-btn').forEach(btn => {
            btn.classList.remove('selected');
        });
        
        // 选中当前按钮
        buttonEl.classList.add('selected');
        this.selectedCategory = keyword;
    }

    async saveEntry() {
        // 验证输入
        if (!this.selectedCategory) {
            new Notice('请选择分类');
            return;
        }

        // 解析输入：支持 "金额 备注" 或 "金额" 格式
        const input = this.amountInput.value.trim();
        if (!input) {
            new Notice('请输入金额');
            return;
        }

        // 使用正则表达式解析：数字（可能带小数点）+ 可选的空格和备注
        const match = input.match(/^([\d.]+)\s*(.*)$/);
        if (!match) {
            new Notice('请输入有效的金额格式，例如：50 午餐');
            return;
        }

        const amount = parseFloat(match[1]);
        const description = match[2].trim();

        if (!amount || amount <= 0) {
            new Notice('请输入有效金额');
            return;
        }

        // 编辑模式：交给调用方就地改写原始记账行，不追加新记录
        if (this.editTarget) {
            const { record } = this.editTarget;
            const keyword = this.selectedCategory;
            this.close();
            // 没有任何改动时不写文件
            if (keyword === record.keyword && description === record.description && amount === record.amount) {
                return;
            }
            await this.editTarget.onUpdate(keyword, description, amount);
            return;
        }

        try {
            // 获取今天的日记文件路径
            const today = new Date();
            const dateStr = formatFileDate(today, this.plugin.config.dateFormat);
            const journalPath = `${this.plugin.config.journalsPath}/${dateStr}.md`;
            
            // 构建记账记录（不带换行符，添加列表符号）
            const emoji = this.plugin.config.expenseEmoji;
            const record = `- ${emoji}${this.selectedCategory} ${amount}${description ? ' ' + description : ''}`;
            
            // 检查文件是否存在
            const file = this.app.vault.getAbstractFileByPath(journalPath);
            
            if (file instanceof TFile) {
                // 文件存在，智能追加内容
                let content = await this.app.vault.read(file);
                
                // 移除末尾的空行或仅含 "-" 的占位行
                const lines = content.split('\n');
                while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                    lines.pop();
                }
                
                // 重新组合内容
                let newContent = lines.join('\n');
                
                // 如果文件非空，添加一个换行符再追加新记录
                if (newContent.length > 0) {
                    newContent += '\n' + record;
                } else {
                    // 文件为空，直接写入记录
                    newContent = record;
                }
                
                await this.app.vault.modify(file, newContent);
            } else {
                // 文件不存在，创建新文件（不带末尾换行）
                await this.app.vault.create(journalPath, record);
            }

            new Notice('记账成功');
            this.close();
            
            // 调用保存后的回调
            if (this.onSave) {
                await this.onSave();
            }
        } catch (error) {
            console.error('保存记账记录失败:', error);
            new Notice('保存失败，请检查日记文件夹');
        }
    }
}

// 快速记账模态框（复制历史记录）
class QuickCopyModal extends Modal {
    plugin: AccountingPlugin;
    records: AccountingRecord[];
    filteredRecords: AccountingRecord[];
    searchInput: HTMLInputElement;
    recordsContainer: HTMLElement;
    selectedCategory: string;
    onSave: () => Promise<void>;

    constructor(app: App, plugin: AccountingPlugin, records: AccountingRecord[], onSave: () => Promise<void>) {
        super(app);
        this.plugin = plugin;
        this.records = records;
        this.filteredRecords = records;
        this.selectedCategory = '';
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('quick-copy-modal');

        this.titleEl.setText('📋 快速记账');

        // 搜索和筛选区域
        const filterSection = contentEl.createDiv('quick-copy-filter');

        // 搜索框
        this.searchInput = filterSection.createEl('input', {
            type: 'text',
            cls: 'quick-copy-search',
            attr: { placeholder: '搜索记录...' }
        });
        this.searchInput.addEventListener('input', () => this.filterRecords());

        // 分类筛选
        const categorySelect = filterSection.createEl('select', { cls: 'quick-copy-category-select' });
        categorySelect.createEl('option', { text: '全部分类', value: '' });
        recordEntries(this.plugin.config.categories).forEach(([keyword, categoryName]) => {
            categorySelect.createEl('option', { text: categoryName, value: keyword });
        });
        categorySelect.addEventListener('change', () => {
            this.selectedCategory = categorySelect.value;
            this.filterRecords();
        });

        // 记录列表容器
        this.recordsContainer = contentEl.createDiv('quick-copy-records');
        this.renderRecords();

        // 底部提示
        const footer = contentEl.createDiv('quick-copy-footer');
        footer.createSpan({ text: `共 ${this.records.length} 条记录`, cls: 'quick-copy-count' });
    }

    filterRecords() {
        const searchText = this.searchInput.value.toLowerCase().trim();

        this.filteredRecords = this.records.filter(record => {
            const matchSearch = !searchText ||
                record.description.toLowerCase().includes(searchText) ||
                record.category.toLowerCase().includes(searchText) ||
                record.keyword.toLowerCase().includes(searchText);

            const matchCategory = !this.selectedCategory ||
                record.keyword === this.selectedCategory;

            return matchSearch && matchCategory;
        });

        this.renderRecords();
    }

    renderRecords() {
        this.recordsContainer.empty();

        if (this.filteredRecords.length === 0) {
            this.recordsContainer.createDiv({ text: '暂无匹配记录', cls: 'quick-copy-empty' });
            return;
        }

        this.filteredRecords.forEach(record => {
            const recordItem = this.recordsContainer.createDiv('quick-copy-item');

            // 记录信息
            const recordInfo = recordItem.createDiv('quick-copy-info');
            const categoryColor = this.getCategoryColor(record.category);
            recordInfo.createSpan({
                text: record.category,
                cls: 'quick-copy-category',
                attr: { style: `background-color: ${categoryColor}20; color: ${categoryColor}` }
            });
            recordInfo.createSpan({
                text: `¥${record.amount}`,
                cls: 'quick-copy-amount'
            });
            recordInfo.createSpan({
                text: record.description || '-',
                cls: 'quick-copy-desc'
            });

            // 操作按钮
            const actions = recordItem.createDiv('quick-copy-actions');

            const copyBtn = actions.createEl('button', {
                text: '复制',
                cls: 'quick-copy-btn'
            });
            copyBtn.onclick = () => this.copyRecord(record);

            const editBtn = actions.createEl('button', {
                text: '编辑',
                cls: 'quick-copy-btn quick-copy-btn-edit'
            });
            editBtn.onclick = () => this.editAndCopyRecord(record);
        });
    }

    getCategoryColor(category: string): string {
        const colors: Record<string, string> = {
            '餐饮': '#dc3545',
            '交通': '#007bff',
            '娱乐': '#6f42c1',
            '购物': '#fd7e14',
            '医疗': '#20c997',
            '教育': '#198754',
            '房租': '#6c757d',
            '其他': '#495057',
            '收入': '#28a745',
            '投资': '#17a2b8',
            '礼物': '#e83e8c',
            '旅游': '#ffc107',
            '运动': '#fd7e14',
            '贷款': '#6c757d',
            '生活缴费': '#17a2b8'
        };
        return colors[category] || '#6c757d';
    }

    async copyRecord(record: AccountingRecord) {
        const emoji = this.plugin.config.expenseEmoji;
        const recordLine = `- ${emoji}${record.keyword}${record.description ? ' ' + record.description : ''} ${record.amount}`;

        try {
            await this.appendRecordToJournal(recordLine);
            new Notice('复制成功');
            this.close();

            // 跳转到今天的日记
            await this.openJournalFileIfNotOpen(formatFileDate(new Date(), this.plugin.config.dateFormat));

            if (this.onSave) {
                await this.onSave();
            }
        } catch (error) {
            console.error('复制记录失败:', error);
            new Notice('复制失败');
        }
    }

    editAndCopyRecord(record: AccountingRecord) {
        new EditCopyModal(this.app, this.plugin, record, async () => {
            this.close();
            await this.openJournalFileIfNotOpen(formatFileDate(new Date(), this.plugin.config.dateFormat));
            if (this.onSave) {
                await this.onSave();
            }
        }).open();
    }

    async appendRecordToJournal(recordLine: string) {
        const today = formatFileDate(new Date(), this.plugin.config.dateFormat);
        const journalPath = `${this.plugin.config.journalsPath}/${today}.md`;
        const file = this.app.vault.getAbstractFileByPath(journalPath);

        if (file instanceof TFile) {
            let content = await this.app.vault.read(file);
            const lines = content.split('\n');

            // 移除末尾的空行或仅含 "-" 的占位行
            while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                lines.pop();
            }

            let newContent = lines.join('\n');
            if (newContent.length > 0) {
                newContent += '\n' + recordLine;
            } else {
                newContent = recordLine;
            }

            await this.app.vault.modify(file, newContent);
        } else {
            await this.app.vault.create(journalPath, recordLine);
        }
    }

    async openJournalFileIfNotOpen(date: string) {
        const filePath = `${this.plugin.config.journalsPath}/${date}.md`;
        const file = this.app.vault.getAbstractFileByPath(filePath);

        if (!(file instanceof TFile)) {
            new Notice('日记文件不存在');
            return;
        }

        // 检查是否已经打开
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        const existingLeaf = leaves.find(leaf =>
            (leaf.view as { file?: TFile }).file?.path === filePath
        );

        if (existingLeaf) {
            // 已打开 → 聚焦到该 tab
            this.app.workspace.setActiveLeaf(existingLeaf);
        } else {
            // 未打开 → 新打开
            const leaf = this.app.workspace.getLeaf();
            await leaf.openFile(file);
        }
    }
}

// 编辑后复制模态框
class EditCopyModal extends Modal {
    plugin: AccountingPlugin;
    record: AccountingRecord;
    amountInput: HTMLInputElement;
    descInput: HTMLInputElement;
    onSave: () => Promise<void>;

    constructor(app: App, plugin: AccountingPlugin, record: AccountingRecord, onSave: () => Promise<void>) {
        super(app);
        this.plugin = plugin;
        this.record = record;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('edit-copy-modal');

        this.titleEl.setText('编辑后复制');

        // 分类显示
        const categorySection = contentEl.createDiv('edit-copy-section');
        categorySection.createEl('label', { text: '分类', cls: 'edit-copy-label' });
        categorySection.createSpan({
            text: this.record.category,
            cls: 'edit-copy-category-display'
        });

        // 描述输入（先填描述）
        const descSection = contentEl.createDiv('edit-copy-section');
        descSection.createEl('label', { text: '描述', cls: 'edit-copy-label' });
        this.descInput = descSection.createEl('input', {
            type: 'text',
            cls: 'edit-copy-input',
            attr: {
                value: this.record.description,
                placeholder: '输入描述...'
            }
        });

        // 金额输入（后改金额）
        const amountSection = contentEl.createDiv('edit-copy-section');
        amountSection.createEl('label', { text: '金额', cls: 'edit-copy-label' });
        this.amountInput = amountSection.createEl('input', {
            type: 'number',
            cls: 'edit-copy-input',
            attr: {
                value: this.record.amount,
                step: '0.01',
                min: '0'
            }
        });

        // 按钮
        const buttons = contentEl.createDiv('edit-copy-buttons');
        const saveBtn = buttons.createEl('button', {
            text: '复制',
            cls: 'edit-copy-btn edit-copy-btn-save'
        });
        saveBtn.onclick = () => this.saveAndCopy();

        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'edit-copy-btn edit-copy-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();

        // 回车保存
        this.descInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') void this.saveAndCopy();
        });
        this.amountInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') void this.saveAndCopy();
        });

        window.setTimeout(() => this.descInput.focus(), 100);
    }

    async saveAndCopy() {
        const amount = parseFloat(this.amountInput.value);
        const description = this.descInput.value.trim();

        if (!amount || amount <= 0) {
            new Notice('请输入有效金额');
            return;
        }

        const emoji = this.plugin.config.expenseEmoji;
        const recordLine = `- ${emoji}${this.record.keyword}${description ? ' ' + description : ''} ${amount}`;

        try {
            await this.appendRecordToJournal(recordLine);
            new Notice('复制成功');
            this.close();

            if (this.onSave) {
                await this.onSave();
            }
        } catch (error) {
            console.error('复制记录失败:', error);
            new Notice('复制失败');
        }
    }

    async appendRecordToJournal(recordLine: string) {
        const today = formatFileDate(new Date(), this.plugin.config.dateFormat);
        const journalPath = `${this.plugin.config.journalsPath}/${today}.md`;
        const file = this.app.vault.getAbstractFileByPath(journalPath);

        if (file instanceof TFile) {
            let content = await this.app.vault.read(file);
            const lines = content.split('\n');

            while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                lines.pop();
            }

            let newContent = lines.join('\n');
            if (newContent.length > 0) {
                newContent += '\n' + recordLine;
            } else {
                newContent = recordLine;
            }

            await this.app.vault.modify(file, newContent);
        } else {
            await this.app.vault.create(journalPath, recordLine);
        }
    }
}

// 账单导入模态框（从 bill.md 解析微信支付截图文字，确认后记账并删除 bill.md）
class BillImportModal extends Modal {
    plugin: AccountingPlugin;
    billInfo: BillInfo;
    onSave: () => Promise<void>;

    keyword: string;
    matchedDescription: string;
    amountInput: HTMLInputElement;
    descInput: HTMLInputElement;
    categorySelect: HTMLSelectElement;

    constructor(app: App, plugin: AccountingPlugin, billInfo: BillInfo, onSave: () => Promise<void>) {
        super(app);
        this.plugin = plugin;
        this.billInfo = billInfo;
        this.onSave = onSave;

        // 自动匹配分类和描述
        const matched = this.autoMatch(billInfo.merchant);
        this.keyword = matched.keyword;
        this.matchedDescription = matched.description;
    }

    autoMatch(merchant: string): { keyword: string; description: string } {
        return matchMerchantCategory(this.plugin.config, merchant);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('bill-import-modal');

        const sourceMeta: Record<BillSource, { label: string; cls: string }> = {
            wechat_bill:    { label: '微信支付完成页', cls: 'bill-platform-wechat' },
            wechat_history: { label: '微信支付账单页', cls: 'bill-platform-wechat' },
            alipay:         { label: '支付宝完成页',   cls: 'bill-platform-alipay' },
            ccb:            { label: '建设银行动账提醒', cls: 'bill-platform-ccb' },
            unknown:        { label: '未知页面',       cls: 'bill-platform-unknown' },
        };
        const meta = sourceMeta[this.billInfo.source];
        this.titleEl.setText('账单导入');

        // ── 收据卡片 ──────────────────────────────────────────────
        const card = contentEl.createDiv('bill-receipt-card');

        // 平台标签
        const badge = card.createDiv('bill-platform-badge ' + meta.cls);
        badge.setText(meta.label);

        // 商户名（主标题）
        card.createDiv('bill-merchant').setText(this.billInfo.merchant);

        // 金额（大字）
        card.createDiv('bill-amount-display').setText(`¥${this.billInfo.amount.toFixed(2)}`);

        // 时间（小字）
        if (this.billInfo.time) {
            card.createDiv('bill-time').setText(this.billInfo.time);
        }

        // ── 表单区 ────────────────────────────────────────────────
        const form = contentEl.createDiv('bill-form');

        // 分类
        const catRow = form.createDiv('bill-form-row');
        catRow.createEl('label', { text: '分类', cls: 'bill-form-label' });
        this.categorySelect = catRow.createEl('select', { cls: 'bill-form-select' });
        recordEntries(this.plugin.config.categories).forEach(([kw, name]) => {
            const opt = this.categorySelect.createEl('option', { text: `${name}（${kw}）`, value: kw });
            if (kw === this.keyword) opt.selected = true;
        });

        // 金额（可修改）
        const amtRow = form.createDiv('bill-form-row');
        amtRow.createEl('label', { text: '金额', cls: 'bill-form-label' });
        this.amountInput = amtRow.createEl('input', {
            type: 'number',
            cls: 'bill-form-input',
            attr: { value: this.billInfo.amount.toFixed(2), step: '0.01', min: '0.01' }
        });

        // 描述
        const descRow = form.createDiv('bill-form-row');
        descRow.createEl('label', { text: '描述', cls: 'bill-form-label' });
        this.descInput = descRow.createEl('input', {
            type: 'text',
            cls: 'bill-form-input',
            attr: { value: this.matchedDescription, placeholder: '可留空' }
        });

        // ── 按钮区 ────────────────────────────────────────────────
        const buttons = contentEl.createDiv('bill-import-buttons');

        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'bill-btn bill-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();

        const confirmBtn = buttons.createEl('button', {
            text: '记账',
            cls: 'bill-btn bill-btn-confirm'
        });
        confirmBtn.onclick = () => this.saveAndClose();

        // 回车确认
        [this.amountInput, this.descInput].forEach(el => {
            el.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') void this.saveAndClose();
            });
        });

        window.setTimeout(() => this.descInput.focus(), 100);
    }

    async saveAndClose() {
        const amount = parseFloat(this.amountInput.value);
        const description = this.descInput.value.trim();
        const keyword = this.categorySelect.value;

        if (!amount || amount <= 0) {
            new Notice('请输入有效金额');
            return;
        }
        if (!keyword) {
            new Notice('请选择分类');
            return;
        }

        const emoji = this.plugin.config.expenseEmoji;
        const recordLine = `- ${emoji}${keyword}${description ? ' ' + description : ''} ${amount}`;

        // 先写入日记，写入成功后才删除 bill.md，写入失败则保留 bill.md
        let written = false;
        try {
            await this.appendRecordToJournal(recordLine);
            written = true;
        } catch (error: unknown) {
            console.error('写入日记失败:', error);
            new Notice('❌ 记账写入失败，bill.md 已保留：' + (error instanceof Error ? error.message : String(error)));
            return;
        }

        if (written) {
            await this.deleteBillFile();
            new Notice('✅ 记账成功，账单已清除');
            this.close();
            await this.openJournalFileIfNotOpen(formatFileDate(new Date(), this.plugin.config.dateFormat));
            if (this.onSave) await this.onSave();
        }
    }

    async appendRecordToJournal(recordLine: string) {
        const today = formatFileDate(new Date(), this.plugin.config.dateFormat);
        const journalPath = `${this.plugin.config.journalsPath}/${today}.md`;
        const file = this.app.vault.getAbstractFileByPath(journalPath);

        if (file instanceof TFile) {
            let content = await this.app.vault.read(file);
            const lines = content.split('\n');
            while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                lines.pop();
            }
            let newContent = lines.join('\n');
            newContent = newContent.length > 0 ? newContent + '\n' + recordLine : recordLine;
            await this.app.vault.modify(file, newContent);
        } else {
            await this.app.vault.create(journalPath, recordLine);
        }
    }

    async deleteBillFile() {
        const billPath = `${this.plugin.config.journalsPath}/bill.md`;
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(billPath)) {
            await adapter.remove(billPath);
        }
    }

    async openJournalFileIfNotOpen(date: string) {
        const filePath = `${this.plugin.config.journalsPath}/${date}.md`;
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;

        const leaves = this.app.workspace.getLeavesOfType('markdown');
        const existingLeaf = leaves.find((leaf: WorkspaceLeaf) => (leaf.view as { file?: TFile }).file?.path === filePath);
        if (existingLeaf) {
            this.app.workspace.setActiveLeaf(existingLeaf);
        } else {
            const leaf = this.app.workspace.getLeaf();
            await leaf.openFile(file);
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// 统计视图
const ACCOUNTING_STATS_VIEW = 'coin-memo-stats-view';

// 分类颜色（主视图与统计视图共用）
const CATEGORY_COLORS: Record<string, string> = {
    '餐饮': '#dc3545',    // 红色
    '交通': '#007bff',    // 蓝色
    '娱乐': '#6f42c1',    // 紫色
    '购物': '#fd7e14',    // 橙色
    '医疗': '#20c997',    // 青色
    '教育': '#198754',    // 绿色
    '房租': '#6c757d',    // 灰色
    '其他': '#495057',    // 深灰色
    '收入': '#28a745',    // 成功绿色
    '投资': '#17a2b8',    // 信息蓝色
    '礼物': '#e83e8c',    // 粉色
    '旅游': '#ffc107',    // 警告黄色
    '运动': '#fd7e14'     // 橙色
};

/** 轻量自定义下拉：点击向下展开选项，避免原生 select 弹层上下顶开 */
class FilterDropdown {
    private containerEl: HTMLElement;
    private triggerEl: HTMLElement;
    private menuEl: HTMLElement | null = null;
    private options: Array<{ value: string; label: string }> = [];
    private value: string = '';
    private onChange: (value: string) => void;
    private closeHandler: (e: MouseEvent) => void;

    private triggerIcon: string | null = null;

    constructor(parentEl: HTMLElement, onChange: (value: string) => void, triggerIcon: string | null = null) {
        this.onChange = onChange;
        this.triggerIcon = triggerIcon;
        this.containerEl = parentEl.createDiv('filter-dropdown');
        this.triggerEl = this.containerEl.createDiv('filter-dropdown-trigger');
        this.triggerEl.onclick = (e) => {
            e.stopPropagation();
            this.toggleMenu();
        };
        this.closeHandler = (e: MouseEvent) => {
            if (!this.containerEl.contains(e.target as Node)) {
                this.closeMenu();
            }
        };
        this.renderTrigger();
    }

    setOptions(options: Array<{ value: string; label: string }>): void {
        this.options = options;
        if (!options.some(o => o.value === this.value)) {
            this.value = options[0]?.value ?? '';
        }
        this.renderTrigger();
    }

    setValue(value: string): void {
        this.value = value;
        this.renderTrigger();
    }

    getValue(): string {
        return this.value;
    }

    private renderTrigger(): void {
        this.triggerEl.empty();
        if (this.triggerIcon) {
            setIcon(this.triggerEl.createSpan('filter-dropdown-icon'), this.triggerIcon);
        }
        const current = this.options.find(o => o.value === this.value);
        this.triggerEl.createSpan({ text: current?.label ?? '', cls: 'filter-dropdown-label' });
        setIcon(this.triggerEl.createSpan('filter-dropdown-arrow'), 'chevron-down');
    }

    private toggleMenu(): void {
        if (this.menuEl) {
            this.closeMenu();
        } else {
            this.openMenu();
        }
    }

    private openMenu(): void {
        this.menuEl = this.containerEl.createDiv('filter-dropdown-menu');
        this.options.forEach(opt => {
            const item = this.menuEl!.createDiv(`filter-dropdown-item ${opt.value === this.value ? 'selected' : ''}`);
            item.setText(opt.label);
            item.onclick = (e) => {
                e.stopPropagation();
                this.setValue(opt.value);
                this.closeMenu();
                this.onChange(opt.value);
            };
        });
        document.addEventListener('click', this.closeHandler);
    }

    private closeMenu(): void {
        this.menuEl?.remove();
        this.menuEl = null;
        document.removeEventListener('click', this.closeHandler);
    }
}

function getCategoryColorShared(category: string): string {
    return CATEGORY_COLORS[category] ?? '#6c757d'; // 默认灰色
}

/** 将总金额/预算卡片、预算告警、分类统计渲染到 container（主视图与统计视图共用） */
function renderStatsInto(container: HTMLElement, stats: AccountingStats | null): void {
    container.empty();

    if (!stats) {
        container.createDiv({ text: '暂无数据', cls: 'no-data' });
        return;
    }

    const { totalIncome, totalExpense, categoryStats, budgetStatus } = stats;
    const balance = totalIncome - totalExpense;

    // 预算告警（如果有）
    if (budgetStatus && budgetStatus.alerts.length > 0) {
        const alertsContainer = container.createDiv('budget-alerts');
        budgetStatus.alerts.forEach(alert => {
            const alertItem = alertsContainer.createDiv(`budget-alert ${alert.type}`);
            const icon = alert.type === 'exceeded' ? '⚠️' : '⚡';
            alertItem.setText(`${icon} ${alert.message}`);
        });
    }

    // 总览统计
    const overview = container.createDiv('stats-overview');

    const incomeCard = overview.createDiv('stat-card income');
    incomeCard.createDiv({ text: '总收入', cls: 'stat-label' });
    incomeCard.createDiv({ text: `¥${totalIncome.toFixed(2)}`, cls: 'stat-value' });

    const expenseCard = overview.createDiv('stat-card expense');
    expenseCard.createDiv({ text: '总支出', cls: 'stat-label' });
    expenseCard.createDiv({ text: `¥${totalExpense.toFixed(2)}`, cls: 'stat-value' });

    const balanceCard = overview.createDiv(`stat-card balance ${balance >= 0 ? 'positive' : 'negative'}`);
    balanceCard.createDiv({ text: '结余', cls: 'stat-label' });
    balanceCard.createDiv({ text: `¥${balance.toFixed(2)}`, cls: 'stat-value' });

    // 预算状态卡片
    if (budgetStatus && budgetStatus.totalBudget > 0) {
        const budgetCard = overview.createDiv('stat-card budget');
        budgetCard.createDiv({ text: '预算状态', cls: 'stat-label' });
        const remaining = budgetStatus.totalRemaining;
        const progressPercent = (budgetStatus.totalProgress * 100).toFixed(0);
        budgetCard.createDiv({
            text: remaining >= 0 ? `剩余 ¥${remaining.toFixed(2)}` : `超支 ¥${Math.abs(remaining).toFixed(2)}`,
            cls: `stat-value ${remaining >= 0 ? 'positive' : 'negative'}`
        });
        budgetCard.createDiv({ text: `已用 ${progressPercent}%`, cls: 'stat-progress' });
    }

    // 分类统计
    if (Object.keys(categoryStats).length > 0) {
        const categorySection = container.createDiv('category-stats');
        categorySection.createEl('h3', { text: '分类统计' });

        const categoryList = categorySection.createDiv('category-list');

        categoryStatEntries(categoryStats)
            .sort(([,a], [,b]) => b.total - a.total)
            .forEach(([category, data]) => {
                const item = categoryList.createDiv('category-item');

                const info = item.createDiv('category-info');

                // 创建彩色标签
                const categoryLabel = info.createDiv('category-label');
                const color = getCategoryColorShared(category);
                categoryLabel.style.setProperty('--cat-color', color);
                categoryLabel.textContent = category;

                const amountInfo = info.createDiv('category-amount-info');
                amountInfo.createDiv({ text: `¥${data.total.toFixed(2)}`, cls: 'category-amount' });
                amountInfo.createDiv({ text: `${data.count}笔`, cls: 'category-count' });

                // 预算进度条（如果有预算设置）
                if (budgetStatus && budgetStatus.categories[category]) {
                    const budgetInfo = budgetStatus.categories[category];
                    const progressBar = item.createDiv('budget-progress');
                    const progressFill = progressBar.createDiv('budget-progress-fill');
                    const progressPercent = Math.min(budgetInfo.progress * 100, 100);
                    progressFill.style.setProperty('--progress-width', `${progressPercent}%`);

                    // 根据进度设置颜色
                    if (budgetInfo.progress >= 1) {
                        progressFill.classList.add('exceeded');
                    } else if (budgetInfo.progress >= 0.8) {
                        progressFill.classList.add('warning');
                    } else {
                        progressFill.classList.add('normal');
                    }

                    const budgetText = item.createDiv('budget-text');
                    budgetText.textContent = `预算: ¥${budgetInfo.budget} | 剩余: ¥${budgetInfo.remaining.toFixed(2)}`;
                }
            });
    }
}

// 记账视图
const ACCOUNTING_VIEW = 'accounting-view';

class AccountingView extends ItemView {
    plugin: AccountingPlugin;
    currentRecords: AccountingRecord[];
    currentStats: AccountingStats;
    filteredRecords: AccountingRecord[];       // 时间筛选后的记录
    categoryFilteredRecords: AccountingRecord[]; // 时间+分类筛选后的记录（用于展示）
    currentDateRange: { start: string; end: string; label: string };
    selectedCategory: string;                  // 当前选中的分类关键词，空字符串表示全部
    statsContainer: HTMLElement;               // 主页面简化统计容器（可通过配置隐藏）
    recordsContainer: HTMLElement;
    timeDisplay: HTMLElement;
    timeFilterEl: FilterDropdown;              // 时间筛选下拉
    categoryFilterEl: FilterDropdown;          // 分类筛选下拉
    activeCategoryDropdown: HTMLElement | null; // 当前打开的分类下拉菜单
    longPressTimer: number | null = null;       // 长按计时器
    longPressEl: HTMLElement | null = null;     // 当前处于长按状态的记录行
    recordMenuShown = false;                    // 本次按压是否已弹出记录菜单（长按与系统菜单去重）

    constructor(leaf: WorkspaceLeaf, plugin: AccountingPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.currentRecords = [];
        this.currentStats = null;
        this.filteredRecords = [];
        this.categoryFilteredRecords = [];
        this.currentDateRange = { start: '', end: '', label: '本月' };
        this.selectedCategory = '';
        this.activeCategoryDropdown = null;
    }

    getViewType() {
        return ACCOUNTING_VIEW;
    }

    getDisplayText() {
        return this.plugin.config.appName || '每日记账';
    }

    getIcon() {
        return 'calculator';
    }

    async onOpen() {
        await this.render();
    }

	    onClose(): Promise<void> {
	        // 清理资源
	        this.cancelLongPress();
	        return Promise.resolve();
	    }

    async render() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('accounting-view');

        this.renderHeader(container);
        this.statsContainer = container.createDiv('main-page-stats');
        this.renderRecordsList(container);
        
        // 初始加载数据
        await this.loadAllRecords();
    }

    renderHeader(container: HTMLElement) {
        const header = container.createDiv('accounting-header');

        // 使用配置的应用名称
        const appName = this.plugin.config.appName || '每日记账';
        header.createEl('h2', { text: `💰 ${appName}`, cls: 'accounting-title' });

        // 标题右侧：时间筛选 + 分类筛选 + 快捷操作
        const actions = header.createDiv('accounting-actions');

        // 时间筛选下拉
        actions.createEl('label', { text: '时间', cls: 'filter-label' });
        this.timeFilterEl = new FilterDropdown(actions, (value) => this.applyTimeRange(value));
        this.timeFilterEl.setOptions([
            { value: 'thisWeek', label: '本周' },
            { value: 'lastWeek', label: '上周' },
            { value: 'thisMonth', label: '本月' },
            { value: 'lastMonth', label: '上月' },
            { value: 'custom', label: '自定义' }
        ]);
        this.timeFilterEl.setValue('thisMonth');

        // 当前时间范围文字（内联，仅自定义时显示）
        this.timeDisplay = actions.createDiv('current-time-display');
        this.timeDisplay.addClass('hidden');

        // 分类筛选下拉
        actions.createEl('label', { text: '分类', cls: 'filter-label' });
        this.categoryFilterEl = new FilterDropdown(actions, (value) => this.applyCategoryFilter(value));
        this.renderCategoryFilterOptions();

        // 快速记账/快速复制
        const quickEntryBtn = actions.createEl('button', {
            text: '快速记账',
            cls: 'accounting-btn accounting-btn-primary'
        });
        quickEntryBtn.onclick = () => this.showQuickEntryModal();

        if (this.plugin.config.enableQuickCopy !== false) {
            const quickCopyBtn = actions.createEl('button', {
                text: '快速复制',
                cls: 'accounting-btn'
            });
            quickCopyBtn.onclick = () => this.showQuickCopyModal();
        }

        const refreshBtn = actions.createDiv('filter-icon-btn');
        refreshBtn.title = '刷新数据';
        setIcon(refreshBtn, 'refresh-cw');
        refreshBtn.onclick = () => { void this.loadAllRecords(true); };

        const moreDropdown = new FilterDropdown(actions, (value) => {
            switch (value) {
                case 'stats':
                    void this.plugin.activateStatsView();
                    break;
                case 'exportMd':
                    this.exportToMarkdown();
                    break;
                case 'exportPdf':
                    this.showExportPDFModal();
                    break;
                case 'config':
                    this.showConfigModal();
                    break;
                case 'reclassify':
                    void this.plugin.activateReclassifyView();
                    break;
            }
            moreDropdown.setValue('');
        }, 'more-horizontal');
        moreDropdown.setOptions([
            { value: '', label: '更多' },
            { value: 'stats', label: '查看统计' },
            { value: 'exportMd', label: '导出 Markdown' },
            { value: 'exportPdf', label: '导出 PDF' },
            { value: 'config', label: '配置分类' },
            { value: 'reclassify', label: '批量重分类' }
        ]);
        moreDropdown.setValue('');
    }

    /** 渲染分类筛选下拉选项（全部 + 各分类） */
    renderCategoryFilterOptions() {
        const options = [{ value: '', label: '全部' }];
        recordEntries(this.plugin.config.categories).forEach(([keyword, categoryName]) => {
            options.push({ value: keyword, label: categoryName });
        });
        this.categoryFilterEl.setOptions(options);
        this.categoryFilterEl.setValue(this.selectedCategory);
    }

    /** 应用分类筛选，在当前时间筛选结果上再过滤 */
    applyCategoryFilter(keyword: string) {
        this.selectedCategory = keyword;

        // 在时间筛选结果上叠加分类筛选
        const base = this.filteredRecords.length > 0 ? this.filteredRecords : this.currentRecords;
        this.categoryFilteredRecords = keyword === ''
            ? base
            : base.filter(r => r.keyword === keyword);

        this.updateRecordsDisplay(this.categoryFilteredRecords);
    }

    // 应用时间范围筛选
    applyTimeRange(rangeKey: string) {
        const now = new Date();
        let startDate, endDate, displayText;

        switch (rangeKey) {
            case 'thisWeek':
                startDate = this.getWeekStart(now);
                endDate = this.getWeekEnd(now);
                displayText = '本周';
                break;

            case 'lastWeek': {
                const lastWeek = new Date(now);
                lastWeek.setDate(lastWeek.getDate() - 7);
                startDate = this.getWeekStart(lastWeek);
                endDate = this.getWeekEnd(lastWeek);
                displayText = '上周';
                break;
            }

            case 'thisMonth':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                displayText = '本月';
                break;

            case 'lastMonth':
                startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                endDate = new Date(now.getFullYear(), now.getMonth(), 0);
                displayText = '上月';
                break;

            case 'custom':
                this.showDateRangePicker();
                return;
        }

        // 格式化日期
        const startStr = this.formatDate(startDate);
        const endStr = this.formatDate(endDate);

        // 应用筛选
        const filteredRecords = this.plugin.storage.filterRecordsByDateRange(
            this.currentRecords, startStr, endStr
        );

        // 保存筛选后的记录和日期范围
        this.filteredRecords = filteredRecords;
        this.currentDateRange = { start: startStr, end: endStr, label: displayText };

        this.currentStats = this.plugin.storage.calculateStatistics(filteredRecords);

        // 预设范围不显示冗余日期文字（下拉已标明）
        this.timeDisplay.addClass('hidden');

        // 时间变化时重置分类筛选
        this.selectedCategory = '';
        this.categoryFilteredRecords = filteredRecords;
        if (this.categoryFilterEl) this.renderCategoryFilterOptions();

        this.updateRecordsDisplay(filteredRecords);
    }

    // 获取周开始日期（周一）
    getWeekStart(date: Date): Date {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // 周一为一周开始
        return new Date(d.setDate(diff));
    }
    
    // 获取周结束日期（周日）
    getWeekEnd(date: Date): Date {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? 0 : 7); // 周日为一周结束
        return new Date(d.setDate(diff));
    }
    
    // 格式化日期为 YYYY-MM-DD（使用本地时区）
    formatDate(date: Date): string {
        return formatLocalDate(date);
    }

    renderRecordsList(container: HTMLElement) {
        this.recordsContainer = container.createDiv('accounting-records');
        this.updateRecordsDisplay();
    }

    async loadAllRecords(forceRefresh = false, preserveFilters = false): Promise<void> {
        try {
            this.currentRecords = await this.plugin.storage.getAllRecords(forceRefresh);
            this.currentStats = this.plugin.storage.calculateStatistics(this.currentRecords);

            if (preserveFilters && this.currentDateRange.start && this.currentDateRange.end) {
                // 保留当前时间筛选和分类筛选
                const filteredRecords = this.plugin.storage.filterRecordsByDateRange(
                    this.currentRecords, this.currentDateRange.start, this.currentDateRange.end
                );
                this.filteredRecords = filteredRecords;
                this.currentStats = this.plugin.storage.calculateStatistics(filteredRecords);

                const base = this.filteredRecords.length > 0 ? this.filteredRecords : this.currentRecords;
                this.categoryFilteredRecords = this.selectedCategory === ''
                    ? base
                    : base.filter(r => r.keyword === this.selectedCategory);

                this.updateTimeButtonState();
                this.updateRecordsDisplay(this.categoryFilteredRecords);
            } else {
                // 默认显示本月数据
                this.applyDefaultTimeRange();
            }
        } catch (error) {
            console.error('加载记账记录失败:', error);
            new Notice('加载记账记录失败');
        }
    }
    
    // 应用默认时间范围（本月）
    applyDefaultTimeRange() {
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        
        const startStr = this.formatDate(startDate);
        const endStr = this.formatDate(endDate);
        
        // 筛选本月数据
        const filteredRecords = this.plugin.storage.filterRecordsByDateRange(
            this.currentRecords, startStr, endStr
        );
        
        // 保存筛选后的记录和日期范围
        this.filteredRecords = filteredRecords;
        this.currentDateRange = { start: startStr, end: endStr, label: '本月' };
        
        this.currentStats = this.plugin.storage.calculateStatistics(filteredRecords);
        
        // 预设范围不显示冗余日期文字
        this.timeDisplay.addClass('hidden');
        
        if (this.timeFilterEl) this.timeFilterEl.setValue('thisMonth');

        // 时间变化时重置分类筛选
        this.selectedCategory = '';
        this.categoryFilteredRecords = filteredRecords;
        if (this.categoryFilterEl) this.renderCategoryFilterOptions();

        this.updateRecordsDisplay(filteredRecords);
    }

    showDateRangePicker() {
        new DateRangeModal(this.app, {
            onSelect: (startDate, endDate) => {
                const filteredRecords = this.plugin.storage.filterRecordsByDateRange(
                    this.currentRecords, startDate, endDate
                );
                
                // 保存筛选后的记录和日期范围
                this.filteredRecords = filteredRecords;
                this.currentDateRange = { start: startDate, end: endDate, label: '自定义' };
                
                this.currentStats = this.plugin.storage.calculateStatistics(filteredRecords);
                
                // 自定义范围显示具体日期
                this.timeDisplay.textContent = `${startDate} 至 ${endDate}`;
                this.timeDisplay.removeClass('hidden');

                if (this.timeFilterEl) this.timeFilterEl.setValue('custom');

                // 时间变化时重置分类筛选
                this.selectedCategory = '';
                this.categoryFilteredRecords = filteredRecords;
                if (this.categoryFilterEl) this.renderCategoryFilterOptions();

                        this.updateRecordsDisplay(filteredRecords);
            }
        }).open();
    }

    /** 根据 currentDateRange 同步时间筛选下拉选中值 */
    updateTimeButtonState() {
        const rangeMap: Record<string, string> = {
            '本月': 'thisMonth',
            '上月': 'lastMonth',
            '本周': 'thisWeek',
            '上周': 'lastWeek',
            '自定义': 'custom'
        };
        const dataRange = rangeMap[this.currentDateRange.label];
        if (this.timeFilterEl && dataRange) {
            this.timeFilterEl.setValue(dataRange);
        }
    }

    // 获取分类颜色
    getCategoryColor(category: string): string {
        const colors: Record<string, string> = {
            '餐饮': '#dc3545',    // 红色
            '交通': '#007bff',    // 蓝色
            '娱乐': '#6f42c1',    // 紫色
            '购物': '#fd7e14',    // 橙色
            '医疗': '#20c997',    // 青色
            '教育': '#198754',    // 绿色
            '房租': '#6c757d',    // 灰色
            '其他': '#495057',    // 深灰色
            '收入': '#28a745',    // 成功绿色
            '投资': '#17a2b8',    // 信息蓝色
            '礼物': '#e83e8c',    // 粉色
            '旅游': '#ffc107',    // 警告黄色
            '运动': '#fd7e14'     // 橙色
        };
        return colors[category] ?? '#6c757d'; // 默认灰色
    }

    /** 主页面简化支出统计：简单表格展示当前时间范围的总支出和分类支出（可在设置中开启，默认隐藏） */
    renderMainPageStats() {
        if (!this.statsContainer) return;

        this.statsContainer.empty();

        if (this.plugin.config.showMainPageStats !== true) {
            this.statsContainer.addClass('hidden');
            return;
        }

        // 基于时间筛选后的记录统计，不受分类筛选影响
        const expenseByCategory: Record<string, number> = {};
        let totalExpense = 0;
        this.filteredRecords.forEach(record => {
            if (record.isIncome) return;
            expenseByCategory[record.category] = (expenseByCategory[record.category] || 0) + record.amount;
            totalExpense += record.amount;
        });

        if (totalExpense <= 0) {
            this.statsContainer.addClass('hidden');
            return;
        }

        this.statsContainer.removeClass('hidden');

        const table = this.statsContainer.createEl('table', { cls: 'main-stats-table' });
        const headRow = table.createEl('thead').createEl('tr');
        headRow.createEl('th', { text: '分类' });
        headRow.createEl('th', { text: '支出' });

        const tbody = table.createEl('tbody');

        const totalRow = tbody.createEl('tr', { cls: 'main-stats-total-row' });
        totalRow.createEl('td', { text: '总支出' });
        totalRow.createEl('td', { text: `¥${totalExpense.toFixed(2)}` });

        recordEntries(expenseByCategory)
            .sort(([, a], [, b]) => b - a)
            .forEach(([category, amount]) => {
                const row = tbody.createEl('tr');
                row.createEl('td', { text: category });
                row.createEl('td', { text: `¥${amount.toFixed(2)}` });
            });
    }

    updateRecordsDisplay(records = this.currentRecords) {
        this.renderMainPageStats();

        if (!this.recordsContainer) return;

        // 列表即将重建，取消可能仍在计时的长按
        this.cancelLongPress();
        this.recordsContainer.empty();
        
        if (!records || records.length === 0) {
            this.recordsContainer.createDiv({ text: '暂无记账记录', cls: 'no-records' });
            return;
        }

        const recordsList = this.recordsContainer.createDiv('records-list');
        recordsList.createEl('h3', { text: `记账记录 (${records.length}条)` });

        // 按日期分组
        const groupedRecords = this.groupRecordsByDate(records);
        
        recordEntries(groupedRecords)
            .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
            .forEach(([date, dayRecords]) => {
                this.renderDayRecords(recordsList, date, dayRecords);
            });
    }

    groupRecordsByDate(records: AccountingRecord[]): Record<string, AccountingRecord[]> {
        const grouped: Record<string, AccountingRecord[]> = {};
        records.forEach(record => {
            if (!grouped[record.date]) {
                grouped[record.date] = [];
            }
            grouped[record.date].push(record);
        });
        return grouped;
    }

    renderDayRecords(container: HTMLElement, date: string, records: AccountingRecord[]) {
        const dayGroup = container.createDiv('day-group');
        
        const dayHeader = dayGroup.createDiv('day-header');
        const dayTotal = records.reduce((sum, r) => sum + (r.isIncome ? r.amount : -r.amount), 0);
        
        const dateSpan = dayHeader.createSpan({ text: this.formatDateDisplay(date), cls: 'day-date clickable' });
        
        // 添加点击事件，打开对应日期的日记
        dateSpan.onclick = async () => {
            await this.openJournalFile(date);
        };
        
        dayHeader.createSpan({ 
            text: `¥${dayTotal.toFixed(2)}`, 
            cls: `day-total ${dayTotal >= 0 ? 'positive' : 'negative'}`
        });

        const recordsList = dayGroup.createDiv('day-records');
        
        records.forEach(record => {
            const recordItem = recordsList.createDiv('record-item');
            
            // 如果是补录记录，添加标记
            if (record.isBackfill) {
                recordItem.classList.add('backfill');
                recordItem.title = `补录记录 (原记录于 ${record.fileDate})`;
            }
            
            const recordInfo = recordItem.createDiv('record-info');
            
            // 创建彩色分类标签
            const categoryLabel = recordInfo.createDiv('record-category-label');
            const color = this.getCategoryColor(record.category);
            categoryLabel.style.setProperty('--cat-color', color);
            categoryLabel.textContent = record.category;

            // 点击分类标签弹出下拉选择分类
            categoryLabel.onclick = (e) => {
                e.stopPropagation();
                this.showCategoryDropdown(categoryLabel, record);
            };

            // 显示描述，如果是补录则高亮日期
            const descDiv = recordInfo.createDiv({ cls: 'record-description' });
            if (record.isBackfill) {
                const dateRegex = buildBackfillRegex(this.plugin.config.dateFormat);
                const parts = record.description.split(dateRegex);
                for (let i = 0; i < parts.length; i++) {
                    if (i % 2 === 1 && dateRegex.test(parts[i])) {
                        descDiv.createEl('strong', { text: parts[i] });
                    } else if (parts[i]) {
                        descDiv.appendText(parts[i]);
                    }
                }
            } else {
                descDiv.setText(record.description);
            }
            
            const recordAmount = recordItem.createDiv('record-amount');
            const amountText = record.isIncome ? `+¥${record.amount}` : `-¥${record.amount}`;
            recordAmount.createDiv({ 
                text: amountText, 
                cls: `amount ${record.isIncome ? 'income' : 'expense'}`
            });
            
            // 右键菜单（移动端系统长按也会触发这里）
            recordItem.oncontextmenu = (e) => {
                e.preventDefault();
                this.cancelLongPress();
                // 本次按压已经由长按逻辑弹过菜单，系统再补一次 contextmenu 时忽略
                if (this.recordMenuShown) return;
                this.showRecordContextMenu({ x: e.clientX, y: e.clientY }, record);
            };

            // 长按手势
            this.attachLongPressHandler(recordItem, record);
        });
    }

    /**
     * 绑定长按手势：长按记录弹出记录菜单（查看原文 / 编辑记录 / 删除记录）。
     * 移动端系统长按触发的 contextmenu 弹的是同一个菜单，靠 recordMenuShown 去重。
     * 只在主键/单指按下时启动计时，移动、抬起、离开都会取消；
     * 按在分类标签上时不触发，保证原有的分类切换点击不受影响。
     */
    attachLongPressHandler(recordItem: HTMLElement, record: AccountingRecord): void {
        const LONG_PRESS_MS = 600;
        const MOVE_TOLERANCE = 10;
        let startX = 0;
        let startY = 0;

        recordItem.addEventListener('pointerdown', (e: PointerEvent) => {
            // 新的一次按压，重置菜单去重标记
            this.recordMenuShown = false;

            // 右键/中键交给原有的上下文菜单
            if (e.button !== 0) return;

            // 分类标签有自己的点击交互，不参与长按
            const target = e.target as HTMLElement | null;
            if (target?.closest('.record-category-label')) return;

            this.cancelLongPress();
            startX = e.clientX;
            startY = e.clientY;
            this.longPressEl = recordItem;
            recordItem.addClass('long-press-active');
            this.longPressTimer = window.setTimeout(() => {
                this.longPressTimer = null;
                this.cancelLongPress();
                // 统一走记录菜单：移动端系统长按弹的也是这个菜单，去重后只出现一个
                this.showRecordContextMenu({ x: startX, y: startY }, record);
            }, LONG_PRESS_MS);
        });

        recordItem.addEventListener('pointermove', (e: PointerEvent) => {
            if (this.longPressTimer === null) return;
            // 滑动/滚动视为取消
            if (Math.abs(e.clientX - startX) > MOVE_TOLERANCE || Math.abs(e.clientY - startY) > MOVE_TOLERANCE) {
                this.cancelLongPress();
            }
        });

        recordItem.addEventListener('pointerup', () => this.cancelLongPress());
        recordItem.addEventListener('pointercancel', () => this.cancelLongPress());
        recordItem.addEventListener('pointerleave', () => this.cancelLongPress());
    }

    /** 取消长按计时并清除按压样式 */
    cancelLongPress(): void {
        if (this.longPressTimer !== null) {
            window.clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        if (this.longPressEl) {
            this.longPressEl.removeClass('long-press-active');
            this.longPressEl = null;
        }
    }

    /** 记录对应的日记文件路径（补录记录取原始文件日期） */
    getRecordFilePath(record: AccountingRecord): string {
        const fileDate = isoToFileDate(record.fileDate, this.plugin.config.dateFormat);
        return `${this.plugin.config.journalsPath}/${fileDate}.md`;
    }

    /** 弹出编辑弹窗（复用快速记账弹窗，编辑模式） */
    showEditRecordModal(record: AccountingRecord): void {
        new QuickEntryModal(
            this.app,
            this.plugin,
            () => this.loadAllRecords(false, true),
            {
                record,
                onUpdate: async (keyword, description, amount) => {
                    await this.updateRecord(record, keyword, description, amount);
                }
            }
        ).open();
    }

    /** 就地改写记账行的分类、描述与金额（只改这一行，保留缩进与列表符号） */
    async updateRecord(
        record: AccountingRecord,
        keyword: string,
        description: string,
        amount: number
    ): Promise<void> {
        const filePath = this.getRecordFilePath(record);
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice(`未找到日记文件: ${filePath}`);
            return;
        }

        try {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            const index = lines.findIndex(line => line.trim() === record.rawLine);
            if (index === -1) {
                new Notice('原始记录已变更，未执行修改');
                await this.loadAllRecords(false, true);
                return;
            }

            const original = lines[index];
            const indent = original.slice(0, original.length - original.trimStart().length);
            lines[index] = indent + buildEditedRecordLine(
                record, keyword, description, amount, this.plugin.config.expenseEmoji
            );
            await this.app.vault.modify(file, lines.join('\n'));
            new Notice('已更新该条记账记录');
            await this.loadAllRecords(false, true);
        } catch (error) {
            console.error('更新记账记录失败:', error);
            new Notice('修改失败');
        }
    }

    /** 弹出删除确认 */
    showDeleteRecordConfirm(record: AccountingRecord): void {
        new ConfirmDeleteRecordModal(
            this.app,
            record,
            this.getRecordFilePath(record),
            async () => { await this.deleteRecord(record); }
        ).open();
    }

    /** 从日记文件中删除该条记账行（只删这一行，不动文件其他内容） */
    async deleteRecord(record: AccountingRecord): Promise<void> {
        const filePath = this.getRecordFilePath(record);
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice(`未找到日记文件: ${filePath}`);
            return;
        }

        try {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            // rawLine 已 trim，按 trim 后内容匹配，兼容带缩进的行
            const index = lines.findIndex(line => line.trim() === record.rawLine);
            if (index === -1) {
                new Notice('原始记录已变更，未执行删除');
                await this.loadAllRecords(false, true);
                return;
            }

            lines.splice(index, 1);
            await this.app.vault.modify(file, lines.join('\n'));
            new Notice('已删除该条记账记录');
            await this.loadAllRecords(false, true);
        } catch (error) {
            console.error('删除记账记录失败:', error);
            new Notice('删除失败');
        }
    }

    /** 在指定元素下方显示分类下拉选择 */
    showCategoryDropdown(anchorEl: HTMLElement, record: AccountingRecord) {
        // 关闭已有下拉
        this.closeCategoryDropdown();

        const dropdown = activeDocument.createElement('div');
        dropdown.addClass('coin-memo-category-dropdown');
        dropdown.setCssStyles({
            position: 'fixed',
            zIndex: '9999',
            minWidth: `${anchorEl.offsetWidth}px`
        });

        recordEntries(this.plugin.config.categories).forEach(([keyword, categoryName]) => {
            const option = dropdown.createDiv('coin-memo-category-option');
            option.setText(categoryName);
            if (keyword === record.keyword) {
                option.addClass('active');
            }
            option.onclick = async (e) => {
                e.stopPropagation();
                if (keyword === record.keyword) {
                    this.closeCategoryDropdown();
                    return;
                }

                const fileDate = isoToFileDate(record.fileDate, this.plugin.config.dateFormat);
                const journalPath = `${this.plugin.config.journalsPath}/${fileDate}.md`;
                const file = this.app.vault.getAbstractFileByPath(journalPath);
                if (file instanceof TFile) {
                    let content = await this.app.vault.read(file);
                    const newLine = ReclassifyEngine.replaceKeyword(
                        record.rawLine, record.keyword, keyword, this.plugin.config.expenseEmoji
                    );
                    content = content.replace(record.rawLine, newLine);
                    await this.app.vault.modify(file, content);
                    await this.loadAllRecords(false, true);
                }
                this.closeCategoryDropdown();
            };
        });

        activeDocument.body.appendChild(dropdown);
        this.activeCategoryDropdown = dropdown;

        // 定位到 anchor 下方
        const rect = anchorEl.getBoundingClientRect();
        const dropdownRect = dropdown.getBoundingClientRect();
        let left = rect.left;
        let top = rect.bottom + 4;
        if (left + dropdownRect.width > window.innerWidth) {
            left = window.innerWidth - dropdownRect.width - 8;
        }
        if (top + dropdownRect.height > window.innerHeight) {
            top = rect.top - dropdownRect.height - 4;
        }
        dropdown.style.left = `${left}px`;
        dropdown.style.top = `${top}px`;

        // 点击外部关闭
        const closeOnClickOutside = (e: MouseEvent) => {
            if (!dropdown.contains(e.target as Node)) {
                this.closeCategoryDropdown();
                activeDocument.removeEventListener('click', closeOnClickOutside);
            }
        };
        // 延迟绑定，避免当前点击立即关闭
        window.setTimeout(() => {
            activeDocument.addEventListener('click', closeOnClickOutside);
        }, 0);
    }

    closeCategoryDropdown() {
        if (this.activeCategoryDropdown) {
            this.activeCategoryDropdown.remove();
            this.activeCategoryDropdown = null;
        }
    }

    showRecordContextMenu(position: { x: number; y: number }, record: AccountingRecord) {
        this.recordMenuShown = true;

        const menu = new Menu();
        menu.onHide(() => { this.recordMenuShown = false; });
        
        menu.addItem(item => {
            item.setTitle('查看原文')
                .setIcon('file-text')
                .onClick(() => {
                    void this.openJournalFile(record.date);
                });
        });

        menu.addItem(item => {
            item.setTitle('编辑记录')
                .setIcon('pencil')
                .onClick(() => {
                    this.showEditRecordModal(record);
                });
        });

        menu.addItem(item => {
            item.setTitle('删除记录')
                .setIcon('trash-2')
                .setWarning(true)
                .onClick(() => {
                    this.showDeleteRecordConfirm(record);
                });
        });

        menu.showAtPosition(position);
    }

    async openJournalFile(date: string) {
        const fileDate = isoToFileDate(date, this.plugin.config.dateFormat);
        const filePath = `${this.plugin.config.journalsPath}/${fileDate}.md`;
        
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf();
            await leaf.openFile(file);
        } else {
            new Notice(`未找到日记文件: ${filePath}`);
        }
    }

    formatDateDisplay(dateStr: string): string {
        const date = new Date(dateStr);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        // 使用本地日期格式，避免 UTC 时区问题
        const todayStr = formatLocalDate(today);
        const yesterdayStr = formatLocalDate(yesterday);
        
        if (dateStr === todayStr) {
            return '今天';
        } else if (dateStr === yesterdayStr) {
            return '昨天';
        } else {
            return date.toLocaleDateString('zh-CN', { 
                month: 'long', 
                day: 'numeric',
                weekday: 'short'
            });
        }
    }

    showConfigModal() {
        new CategoryConfigModal(this.app, this.plugin).open();
    }
    
    showQuickEntryModal() {
        new QuickEntryModal(this.app, this.plugin, async () => {
            // 保存后的回调：刷新数据
            await this.loadAllRecords(true);
        }).open();
    }

    showQuickCopyModal() {
        // 获取最近N天的记录（去重）
        const days = this.plugin.config.quickCopyDays || 14;
        const recentRecords = this.getRecentUniqueRecords(days);

        if (recentRecords.length === 0) {
            new Notice('暂无最近记账记录');
            return;
        }

        new QuickCopyModal(this.app, this.plugin, recentRecords, async () => {
            // 保存后的回调：刷新数据
            await this.loadAllRecords(true);
        }).open();
    }

    getRecentUniqueRecords(days: number): AccountingRecord[] {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - days);
        const startStr = formatLocalDate(startDate);

        // 筛选最近N天的记录
        const recentRecords = this.currentRecords.filter(r => r.date >= startStr);

        // 去重：相同关键词+金额+描述只保留一条
        const seen = new Set<string>();
        const uniqueRecords: AccountingRecord[] = [];

        for (const record of recentRecords) {
            const key = `${record.keyword}|${record.amount}|${record.description}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueRecords.push(record);
            }
        }

        // 按最近使用时间排序
        uniqueRecords.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        return uniqueRecords;
    }

    showExportPDFModal() {
        if (this.filteredRecords.length === 0) {
            new Notice('当前时间范围内没有记账记录');
            return;
        }
        
        new ExportPDFModal(
            this.app, 
            this.plugin, 
            this.filteredRecords, 
            this.currentStats, 
            this.currentDateRange
        ).open();
    }

    exportToMarkdown() {
        if (this.filteredRecords.length === 0) {
            new Notice('当前时间范围内没有记账记录');
            return;
        }

        try {
            const markdown = this.generateMarkdown();
            
            // 生成默认文件名：应用名_时间范围
            const appName = this.plugin.config.appName || '每日记账';
            const fileName = buildExportFileName(appName, this.currentDateRange.start, this.currentDateRange.end);
            
            // 显示导出模态框
            new MarkdownExportModal(this.app, markdown, fileName).open();
        } catch (error) {
            console.error('导出 Markdown 失败:', error);
            new Notice('导出失败，请重试');
        }
    }

    generateMarkdown(): string {
        const appName = this.plugin.config.appName || '每日记账';
        const { totalIncome, totalExpense, categoryStats } = this.currentStats;
        const balance = totalIncome - totalExpense;
        
        let md = '';
        
        // 标题和标签
        md += `# ${appName} - 账单报告\n\n`;
        md += `#每日记账 #账单报告\n\n`;
        md += `时间范围: ${this.currentDateRange.start} 至 ${this.currentDateRange.end} | 总收入: ¥${totalIncome.toFixed(2)} | 总支出: ¥${totalExpense.toFixed(2)} | 结余: ¥${balance.toFixed(2)}\n\n`;
        
        // 分类统计
        if (Object.keys(categoryStats).length > 0) {
            md += `## 分类统计\n\n`;
            md += `| 分类 | 金额 | 笔数 | 占比 |\n`;
            md += `|------|------|------|------|\n`;
            
            const totalForPercentage = totalExpense > 0 ? totalExpense : 1;
            
            categoryStatEntries(categoryStats)
                .sort(([,a], [,b]) => b.total - a.total)
                .forEach(([category, data]) => {
                    const isIncome = data.records.some(r => r.isIncome);
                    const percentage = isIncome ? '-' : `${((data.total / totalForPercentage) * 100).toFixed(1)}%`;
                    md += `| ${category} | ¥${data.total.toFixed(2)} | ${data.count} | ${percentage} |\n`;
                });
            
            md += '\n';
        }
        
        // 详细记录 - 一个大表格
        md += `## 详细记录 (共 ${this.filteredRecords.length} 笔)\n\n`;
        md += `| 日期 | 分类 | 描述 | 金额 |\n`;
        md += `|------|------|------|------|\n`;
        
        // 按日期排序（最新的在前）
        const sortedRecords = [...this.filteredRecords].sort((a, b) => 
            new Date(b.date).getTime() - new Date(a.date).getTime()
        );
        
        sortedRecords.forEach(record => {
            const amount = record.isIncome ? `+${record.amount.toFixed(2)}` : `-${record.amount.toFixed(2)}`;
            const desc = record.description || '-';
            md += `| ${record.date} | ${record.category} | ${desc} | ${amount} |\n`;
        });
        
        return md;
    }
}

// 主插件类
export default class AccountingPlugin extends Plugin {
    config: AccountingConfig;
    storage: AccountingStorage;
    
    async onload() {
        // 加载配置
        await this.loadConfig();
        
        // 初始化存储管理器
        this.storage = new AccountingStorage(this.app, this.config);

        // 监听日记文件变化（Alfred/外部写入等），清除缓存并刷新视图，无需定时轮询
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && this.storage.onFileChange(file)) {
                    void this.refreshData();
                }
            })
        );
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file instanceof TFile && this.storage.onFileChange(file)) {
                    void this.refreshData();
                }
            })
        );
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile && this.storage.onFileChange(file)) {
                    void this.refreshData();
                }
            })
        );
        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                if (file instanceof TFile && this.storage.onFileChange(file)) {
                    void this.refreshData();
                }
            })
        );

        // 注册视图
        this.registerView(ACCOUNTING_VIEW, (leaf) => new AccountingView(leaf, this));
        this.registerView(ACCOUNTING_STATS_VIEW, (leaf) => new AccountingStatsView(leaf, this));
        this.registerView(RECLASSIFY_VIEW, (leaf) => new ReclassifyView(leaf, this));

        // 添加功能区图标
        const appName = this.config.appName || '每日记账';
        this.addRibbonIcon('calculator', appName, () => {
            void this.activateView();
        });

        // 快速记账侧边栏图标（根据配置显示）
        if (this.config.enableQuickCopy !== false) {
            this.addRibbonIcon('copy', '快速记账', () => {
                void this.openQuickCopy();
            });
        }

        // 添加命令
        this.addCommand({
            id: 'open-accounting',
            name: `打开${appName}`,
            callback: () => this.activateView()
        });

        this.addCommand({
            id: 'refresh-accounting',
            name: '刷新记账数据',
            callback: () => { void this.refreshData(); }
        });

        this.addCommand({
            id: 'quick-entry',
            name: '新建记账',
            icon: 'wallet',
            callback: () => this.openQuickEntry()
        });

        // 快速记账命令（根据配置注册）
        if (this.config.enableQuickCopy !== false) {
            this.addCommand({
                id: 'quick-copy',
                name: '快速记账',
                icon: 'copy',
                callback: () => this.openQuickCopy()
            });
        }

        this.addCommand({
            id: 'bill-import',
            name: '从账单导入记账（bill.md）',
            icon: 'receipt',
            callback: () => this.openBillImport()
        });

        this.addCommand({
            id: 'export-pdf',
            name: '导出账单 PDF',
            icon: 'file-down',
            callback: () => this.exportPDF()
        });

        this.addCommand({
            id: 'export-markdown',
            name: '导出账单 Markdown',
            icon: 'file-text',
            callback: () => this.exportMarkdown()
        });

        this.addCommand({
            id: 'reclassify',
            name: '批量重分类',
            callback: () => this.activateReclassifyView()
        });

        this.addCommand({
            id: 'open-stats',
            name: '打开记账统计',
            icon: 'bar-chart-3',
            callback: () => { void this.activateStatsView(); }
        });

        // 添加设置页面
        this.addSettingTab(new AccountingSettingTab(this.app, this));
    }

    onunload() {
        // Don't detach leaves - Obsidian handles view lifecycle
    }

    async loadConfig() {
        try {
            const configPath = `${this.manifest.dir}/config.json`;
            const adapter = this.app.vault.adapter;
            const defaults = this.getDefaultConfig();

            let loaded: Partial<AccountingConfig> = {};
            if (await adapter.exists(configPath)) {
                const configContent = await adapter.read(configPath);
                loaded = JSON.parse(configContent) as Partial<AccountingConfig>;
            }

            // 以默认配置为基础合并用户配置，避免 reinstall/update 时新增字段或用户规则丢失
            this.config = {
                ...defaults,
                ...loaded,
                categories: { ...defaults.categories, ...(loaded.categories || {}) }
            };

            // 优先从 Daily Notes 插件获取配置
            const dailyNoteConfig = getDailyNoteConfig(this.app);
            if (!this.config.journalsPath || typeof this.config.journalsPath !== 'string') {
                this.config.journalsPath = dailyNoteConfig?.folder || 'journals';
            }
            if (!this.config.dateFormat || typeof this.config.dateFormat !== 'string') {
                this.config.dateFormat = dailyNoteConfig?.format || 'yyyy-MM-dd';
            }
        } catch (error) {
            console.error('加载配置失败:', error);
            this.config = this.getDefaultConfig();
        }
    }

    async saveConfig() {
        try {
            const configPath = `${this.manifest.dir}/config.json`;
            const adapter = this.app.vault.adapter;
            const configContent = JSON.stringify(this.config, null, 4);
            await adapter.write(configPath, configContent);
            // 清除缓存，重新加载数据
            if (this.storage) {
                this.storage.clearCache();
            }
        } catch (error) {
            console.error('保存配置失败:', error);
            new Notice('保存配置失败');
        }
    }

    getDefaultConfig() {
        return {
            appName: "每日记账",
            categories: {
                "sr": "收入",
                "cy": "餐饮",
                "jt": "交通出行",
                "gw": "购物",
                "dk": "贷款",
                "jf": "生活缴费",
                "yj": "悦己奖励",
                "qt": "其他"
            },
            defaultCategory: "jt", // 默认分类为交通出行
            expenseEmoji: "#",
            journalsPath: "journals",
            dateFormat: "yyyy-MM-dd",
            enableQuickCopy: true, // 默认启用快速记账
            quickCopyDays: 14, // 默认显示最近14天的记录
            reclassifyRules: [] // 默认无批量重分类规则
        };
    }

    async activateView() {
        const { workspace } = this.app;
        
        // 检查是否已经有打开的视图
        let leaf = workspace.getLeavesOfType(ACCOUNTING_VIEW)[0];
        
        if (!leaf) {
            // 创建新的标签页
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({
                type: ACCOUNTING_VIEW,
                active: true
            });
        }
        
        // 激活视图并确保已有的自定义标签页真正切到前台
        await workspace.revealLeaf(leaf);
        
        // 强制刷新数据，打开视图时重置筛选
        if (leaf.view instanceof AccountingView) {
            await leaf.view.loadAllRecords(true, false);
        }

        // 执行标记了 autoApply 的重分类规则（静默，不弹窗）
        await this.runAutoApplyRules();
    }

    /** 静默执行所有 autoApply=true 的重分类规则，只处理最近 7 天，完成后刷新视图 */
    async runAutoApplyRules(): Promise<void> {
        const autoRules = (this.config.reclassifyRules || []).filter(r => r.autoApply && r.keyword && r.toCategory);
        if (autoRules.length === 0) return;

        try {
            const allRecords = await this.storage.getAllRecords();

            // 只处理最近 7 天的记录
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            const startDate = formatLocalDate(sevenDaysAgo);
            const endDate = formatLocalDate(new Date());
            const recentRecords = this.storage.filterRecordsByDateRange(allRecords, startDate, endDate);

            const result = ReclassifyEngine.dryRun(
                autoRules,
                recentRecords,
                this.config.expenseEmoji,
                this.config.journalsPath,
                this.config.dateFormat
            );
            if (result.totalCount === 0) return;

            await ReclassifyEngine.commit(this.app, result);
            this.storage.clearCache();

            // 刷新记账视图
            await this.refreshData();

            new Notice(`自动分类完成：已修改 ${result.totalCount} 条记录`);
        } catch (error) {
            console.error('自动分类失败:', error);
        }
    }

    async activateReclassifyView() {
        const { workspace } = this.app;

        // 检查是否已有打开的 RECLASSIFY_VIEW
        const existing = workspace.getLeavesOfType(RECLASSIFY_VIEW)[0];
        if (existing) {
            workspace.setActiveLeaf(existing, { focus: true });
            return;
        }

        // 在新标签页打开
        const leaf = workspace.getLeaf(true);
        await leaf.setViewState({
            type: RECLASSIFY_VIEW,
            active: true
        });
        workspace.setActiveLeaf(leaf, { focus: true });
    }

    async activateStatsView() {
        const { workspace } = this.app;

        // 检查是否已有打开的统计视图
        const existing = workspace.getLeavesOfType(ACCOUNTING_STATS_VIEW)[0];
        if (existing) {
            await workspace.revealLeaf(existing);
            if (existing.view instanceof AccountingStatsView) {
                await existing.view.loadStats(true);
            }
            return;
        }

        // 在新标签页打开
        const leaf = workspace.getLeaf('tab');
        await leaf.setViewState({
            type: ACCOUNTING_STATS_VIEW,
            active: true
        });
        await workspace.revealLeaf(leaf);
    }

    async refreshData(preserveFilters = true) {
        const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
        for (const leaf of leaves) {
            if (leaf.view instanceof AccountingView) {
                await leaf.view.loadAllRecords(false, preserveFilters);
            }
        }

        const statsLeaves = this.app.workspace.getLeavesOfType(ACCOUNTING_STATS_VIEW);
        for (const leaf of statsLeaves) {
            if (leaf.view instanceof AccountingStatsView) {
                await leaf.view.loadStats();
            }
        }
    }

    openQuickEntry() {
        // 打开快速记账模态框
        new QuickEntryModal(this.app, this, async () => {
            // 保存后的回调：刷新所有打开的记账视图
            await this.refreshData();
        }).open();
    }

    async openQuickCopy() {
        // 获取最近N天的记录
        const days = this.config.quickCopyDays || 14;

        // 先加载所有记录
        const allRecords = await this.storage.getAllRecords();

        // 筛选并去重
        const recentRecords = this.getRecentUniqueRecords(allRecords, days);

        if (recentRecords.length === 0) {
            new Notice('暂无最近记账记录');
            return;
        }

        new QuickCopyModal(this.app, this, recentRecords, async () => {
            // 保存后的回调：刷新所有打开的记账视图
            await this.refreshData();
        }).open();
    }

    async openBillImport() {
        const billPath = `${this.config.journalsPath}/bill.md`;
        const adapter = this.app.vault.adapter;

        // bill.md 可能刚被快捷指令写入，绕过 Obsidian 缓存直接用 adapter 读取
        // 最多重试 5 次（共等待约 500ms），兼容文件刚写入的时序差
        const MAX_RETRIES = 5;
        const RETRY_DELAY = 100;
        let content = '';
        for (let i = 0; i < MAX_RETRIES; i++) {
            if (await adapter.exists(billPath)) {
                content = await adapter.read(billPath);
                if (content.trim()) break;
            }
            if (i < MAX_RETRIES - 1) {
                await new Promise(resolve => window.setTimeout(resolve, RETRY_DELAY));
            }
        }

        if (!content.trim()) {
            new Notice(`未找到账单文件或文件为空：${billPath}`);
            return;
        }

        // 按 ### 分隔多条截图内容，只取最后一段（最新的一笔）
        const sections = content.split(/^###\s*$/m).map(s => s.trim()).filter(s => s.length > 0);
        const lastSection = sections[sections.length - 1] ?? '';
        if (!lastSection) {
            new Notice('账单文件内容无效');
            return;
        }

        const deleteBill = async () => {
            if (await adapter.exists(billPath)) {
                await adapter.remove(billPath);
            }
        };

        const billInfo = parseBillContent(lastSection);

        // 完全未识别任何页面类型
        if (!billInfo) {
            new Notice('⚠️ 无法识别截图类型，bill.md 已保留。目前支持：微信支付完成页、微信支付账单页、支付宝完成页、建设银行动账提醒。', 5000);
            return;
        }

        // 识别到页面类型但字段解析失败（金额/商户缺失）
        if (!billInfo.merchant || billInfo.amount <= 0) {
            const sourceMeta: Record<BillSource, string> = {
                wechat_bill: '微信支付完成页',
                wechat_history: '微信支付账单页',
                alipay: '支付宝',
                ccb: '建设银行动账提醒',
                unknown: '未知页面',
            };
            new Notice(`⚠️ 识别到「${sourceMeta[billInfo.source]}」，但解析金额/商户失败，bill.md 已保留。`, 5000);
            return;
        }

        // 静默记账：识别成功后直接写入日记，不弹确认框
        if (this.config.silentBillImport) {
            const { keyword, description } = matchMerchantCategory(this.config, billInfo.merchant);
            const emoji = this.config.expenseEmoji;
            const recordLine = `- ${emoji}${keyword}${description ? ' ' + description : ''} ${billInfo.amount}`;
            const today = formatFileDate(new Date(), this.config.dateFormat);
            const journalPath = `${this.config.journalsPath}/${today}.md`;

            try {
                const file = this.app.vault.getAbstractFileByPath(journalPath);
                if (file instanceof TFile) {
                    let fileContent = await this.app.vault.read(file);
                    const lines = fileContent.split('\n');
                    while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                        lines.pop();
                    }
                    let newContent = lines.join('\n');
                    newContent = newContent.length > 0 ? newContent + '\n' + recordLine : recordLine;
                    await this.app.vault.modify(file, newContent);
                } else {
                    await this.app.vault.create(journalPath, recordLine);
                }
                await deleteBill();
                new Notice(`✅ 静默记账：${keyword} ${description || billInfo.merchant} ${billInfo.amount}`);
                await this.refreshData();
                // 打开今日日记文件
                const journalFile = this.app.vault.getAbstractFileByPath(journalPath);
                if (journalFile instanceof TFile) {
                    const leaves = this.app.workspace.getLeavesOfType('markdown');
                    const existingLeaf = leaves.find((leaf: WorkspaceLeaf) => (leaf.view as { file?: TFile }).file?.path === journalPath);
                    if (existingLeaf) {
                        this.app.workspace.setActiveLeaf(existingLeaf);
                    } else {
                        const leaf = this.app.workspace.getLeaf();
                        await leaf.openFile(journalFile);
                    }
                }
            } catch (error: unknown) {
                console.error('[bill-import] 静默记账写入失败:', error);
                new Notice('❌ 静默记账写入失败，bill.md 已保留：' + String(error));
            }
            return;
        }

        new BillImportModal(this.app, this, billInfo, async () => {
            await this.refreshData();
        }).open();
    }

    getRecentUniqueRecords(allRecords: AccountingRecord[], days: number): AccountingRecord[] {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - days);
        const startStr = formatLocalDate(startDate);

        // 筛选最近N天的记录
        const recentRecords = allRecords.filter(r => r.date >= startStr);

        // 去重：相同关键词+金额+描述只保留一条
        const seen = new Set<string>();
        const uniqueRecords: AccountingRecord[] = [];

        for (const record of recentRecords) {
            const key = `${record.keyword}|${record.amount}|${record.description}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueRecords.push(record);
            }
        }

        // 按最近使用时间排序
        uniqueRecords.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        return uniqueRecords;
    }

    async exportPDF() {
        // 先确保视图已打开
        const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
        if (leaves.length > 0 && leaves[0].view instanceof AccountingView) {
            const view = leaves[0].view;
            view.showExportPDFModal();
        } else {
            // 如果视图未打开，先打开视图再导出
            await this.activateView();
            window.setTimeout(() => {
                const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
                if (leaves.length > 0 && leaves[0].view instanceof AccountingView) {
                    const view = leaves[0].view;
                    view.showExportPDFModal();
                }
            }, 500);
        }
    }

    async exportMarkdown() {
        // 先确保视图已打开
        const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
        if (leaves.length > 0 && leaves[0].view instanceof AccountingView) {
            const view = leaves[0].view;
            view.exportToMarkdown();
        } else {
            // 如果视图未打开，先打开视图再导出
            await this.activateView();
            window.setTimeout(() => {
                const leaves = this.app.workspace.getLeavesOfType(ACCOUNTING_VIEW);
                if (leaves.length > 0 && leaves[0].view instanceof AccountingView) {
                    const view = leaves[0].view;
                    void view.exportToMarkdown();
                }
            }, 500);
        }
    }
}

// 设置页面
class AccountingSettingTab extends PluginSettingTab {
    plugin: AccountingPlugin;

    constructor(app: App, plugin: AccountingPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl).setName('记账管理插件设置').setHeading();

        const dailyNoteConfig = getDailyNoteConfig(this.app);
        const journalsDesc = dailyNoteConfig?.folder
            ? `检测到日记插件文件夹: ${dailyNoteConfig.folder}，已自动应用。可在此改为单独路径。`
            : '日记文件存放的文件夹路径（相对 vault 根目录），默认为 journals';

        new Setting(containerEl)
            .setName('日记文件夹路径')
            .setDesc(journalsDesc)
            .addText(text => text
                .setPlaceholder('Journals')
                .setValue(this.plugin.config.journalsPath || 'journals')
                .onChange(async (value) => {
                    const normalizedPath = (value || 'journals').trim().replace(/^\/+/, '').replace(/\/+$/, '');
                    this.plugin.config.journalsPath = normalizedPath || 'journals';
                    await this.plugin.saveConfig();
                    // 清除缓存并刷新视图
                    if (this.plugin.storage) {
                        this.plugin.storage.clearCache();
                        await this.plugin.refreshData();
                    }
                }));

        new Setting(containerEl)
            .setName('启用快速记账')
            .setDesc('在侧边栏显示"快速记账"按钮，记账视图中显示"快速复制"按钮，可快速复制最近n天的记账记录到今天')
            .addToggle(toggle => toggle
                .setValue(this.plugin.config.enableQuickCopy !== false)
                .onChange(async (value) => {
                    this.plugin.config.enableQuickCopy = value;
                    await this.plugin.saveConfig();
                    // 刷新视图
                    await this.plugin.refreshData();
                }));

        new Setting(containerEl)
            .setName('在主页面显示支出统计')
            .setDesc('开启后，记账主页面顶部以简单表格显示当前时间范围的总支出和各分类支出（默认隐藏，完整统计请打开统计页面）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.config.showMainPageStats === true)
                .onChange(async (value) => {
                    this.plugin.config.showMainPageStats = value;
                    await this.plugin.saveConfig();
                    // 刷新视图
                    await this.plugin.refreshData();
                }));

        new Setting(containerEl)
            .setName('快速记账天数')
            .setDesc('快速记账显示最近n天的记录（默认14天）')
            .addText(text => text
                .setPlaceholder('14')
                .setValue(String(this.plugin.config.quickCopyDays || 14))
                .onChange(async (value) => {
                    const days = parseInt(value) || 14;
                    this.plugin.config.quickCopyDays = Math.max(1, Math.min(365, days));
                    await this.plugin.saveConfig();
                }));

        const presetFormats = ['yyyy-MM-dd', 'yyyy年MM月dd日', 'yyyy/MM/dd', 'yyyyMMdd', 'DD-MM-YYYY', 'MM-dd-yyyy', 'yy.MM.dd', 'yy.MM.dd-星期', 'yy.MM.dd-周'];
        const currentFormat = this.plugin.config.dateFormat || 'yyyy-MM-dd';
        const isPreset = presetFormats.some(fmt => fmt === currentFormat);

        let customInputSetting: Setting;

        new Setting(containerEl)
            .setName('日记文件命名格式')
            .setDesc('日记文件的日期命名格式。修改后已有的日记文件需要对应重命名。')
            .addDropdown(dropdown => {
                presetFormats.forEach(fmt => {
                    dropdown.addOption(fmt, fmt);
                });
                dropdown.addOption('__custom__', '自定义...');
                dropdown.setValue(isPreset ? currentFormat : '__custom__');
                dropdown.onChange(async (value) => {
                    if (value === '__custom__') {
                        customInputSetting.settingEl.show();
                        const input = customInputSetting.settingEl.querySelector('input') as HTMLInputElement;
                        if (input) {
                            input.value = this.plugin.config.dateFormat || '';
                            input.focus();
                        }
                    } else {
                        customInputSetting.settingEl.hide();
                        this.plugin.config.dateFormat = value;
                        await this.plugin.saveConfig();
                        if (this.plugin.storage) {
                            this.plugin.storage.clearCache();
                            await this.plugin.refreshData();
                        }
                    }
                });
            });

        customInputSetting = new Setting(containerEl)
            .setName('自定义日期格式')
            .setDesc('Token 规则：yyyy/YYYY=四位年, yy/YY=两位年(26), MM=月, dd/DD=日, 星期/星期X=中文星期长格式(星期五), 周/周X=短格式(周五)')
            .addText(text => text
                .setPlaceholder('如: yyyy-MM-dd')
                .setValue(isPreset ? '' : currentFormat)
                .onChange(async (value) => {
                    const trimmed = value.trim();
                    if (trimmed) {
                        this.plugin.config.dateFormat = trimmed;
                        await this.plugin.saveConfig();
                        if (this.plugin.storage) {
                            this.plugin.storage.clearCache();
                            await this.plugin.refreshData();
                        }
                    }
                }));

        if (isPreset) {
            customInputSetting.settingEl.hide();
        }

        const detectedFormat = dailyNoteConfig?.format;
        const tipParts = ['修改后会自动保存并刷新数据。'];
        if (detectedFormat) {
            tipParts.push(`检测到日记插件格式: ${detectedFormat}，已自动应用。可在此改为单独格式。`);
        } else {
            tipParts.push('日记文件应存放在此文件夹下，格式默认为 yyyy-mm-dd.md。');
        }
        containerEl.createEl('p', {
            text: `💡 提示：${tipParts.join('')}`,
            cls: 'setting-item-description'
        });

        // ── 账单导入（bill.md）商户分类配置 ──────────────────────────────────
        new Setting(containerEl).setName('账单导入 - 商户自动分类').setHeading();

        new Setting(containerEl)
            .setName('静默记账')
            .setDesc('开启后，截图账单识别成功时不弹确认框，直接写入今日日记。适合快捷指令自动化场景。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.config.silentBillImport === true)
                .onChange(async (value) => {
                    this.plugin.config.silentBillImport = value;
                    await this.plugin.saveConfig();
                }));

        containerEl.createEl('p', {
            text: '每行一条，格式：商户关键字=分类关键词=描述（描述可省略）。执行「从账单导入记账」命令时，自动根据识别到的商户名匹配分类和描述。',
            cls: 'setting-item-description'
        });
        containerEl.createEl('p', {
            text: '示例：\n豆磨坊=cy=买豆腐\n麦当劳=cy=麦当劳\n盒马=gw',
            cls: 'setting-item-description'
        });

        const merchantMap: Record<string, MerchantMapEntry> =
            this.plugin.config.billMerchantMap || {};
        const merchantLines = recordEntries(merchantMap)
            .map(([k, v]) => v.description ? `${k}=${v.category}=${v.description}` : `${k}=${v.category}`)
            .join('\n');

        new Setting(containerEl)
            .setName('商户分类映射')
            .setDesc('格式：商户关键字=分类关键词=描述（描述可省略，留空时记账描述也为空）')
            .addTextArea(ta => {
                ta.setPlaceholder('豆磨坊=cy=买豆腐\n麦当劳=cy=麦当劳\n盒马=gw');
                ta.setValue(merchantLines);
                ta.inputEl.rows = 8;
                ta.inputEl.addClass('merchant-textarea');
                ta.onChange(async (value) => {
                    const map: Record<string, { category: string; description?: string }> = {};
                    value.split('\n').forEach(line => {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.includes('=')) return;
                        const parts = trimmed.split('=');
                        const merchantKey = parts[0].trim();
                        const category = parts[1]?.trim();
                        const description = parts.slice(2).join('=').trim(); // 描述可含=
                        if (merchantKey && category) {
                            map[merchantKey] = description ? { category, description } : { category };
                        }
                    });
                    this.plugin.config.billMerchantMap = map;
                    await this.plugin.saveConfig();
                });
            });

        // 打赏区
        const donateSection = containerEl.createDiv({ cls: 'accounting-donate-section' });
        new Setting(donateSection).setName('☕ 请作者喝杯咖啡').setHeading();
        const donateDesc = donateSection.createEl('p', { cls: 'accounting-donate-desc' });
        donateDesc.setText('如果这个插件帮助了你，欢迎请作者喝杯咖啡 ☕');

        const imgWrap = donateSection.createDiv({ cls: 'accounting-donate-qr' });
        const imgSrc = "https://raw.githubusercontent.com/fengshuzi/images/main/wechat-donate.jpg";
        const donateImg = imgWrap.createEl('img', { attr: { src: imgSrc, alt: '微信打赏' }, cls: 'plugin-donate-img' });
        donateImg.addEventListener('click', () => {
            const overlay = document.body.createDiv({ cls: 'plugin-donate-lightbox' });
            overlay.createEl('img', { attr: { src: imgSrc, alt: '微信打赏' }, cls: 'plugin-donate-lightbox-img' });
            overlay.addEventListener('click', () => overlay.remove());
        });
        imgWrap.createEl('p', { text: '微信扫码', cls: 'accounting-donate-label' });
    }
}

// ── 统计视图 ─────────────────────────────────────────────────────────────────

class AccountingStatsView extends ItemView {
    plugin: AccountingPlugin;
    statsContainer: HTMLElement;
    timeDisplay: HTMLElement;
    currentDateRange: { start: string; end: string; label: string };

    constructor(leaf: WorkspaceLeaf, plugin: AccountingPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.currentDateRange = { start: '', end: '', label: '本月' };
    }

    getViewType(): string {
        return ACCOUNTING_STATS_VIEW;
    }

    getDisplayText(): string {
        return '记账统计';
    }

    getIcon(): string {
        return 'bar-chart-3';
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('accounting-view');

        const header = container.createDiv('accounting-header');
        header.createEl('h2', { text: '📊 记账统计', cls: 'accounting-title' });

        const actions = header.createDiv('accounting-actions');
        const refreshBtn = actions.createEl('button', {
            text: '刷新数据',
            cls: 'accounting-btn'
        });
        refreshBtn.onclick = () => { void this.loadStats(true); };

        this.renderFilters(container);
        this.statsContainer = container.createDiv('accounting-stats');
        await this.loadStats();
    }

    renderFilters(container: HTMLElement): void {
        const filters = container.createDiv('accounting-filters');
        const row = filters.createDiv('filter-row');

        row.createEl('label', { text: '时间', cls: 'filter-label' });
        const dropdown = new FilterDropdown(row, (value) => { this.applyTimeRange(value); });
        dropdown.setOptions([
            { value: 'thisWeek', label: '本周' },
            { value: 'lastWeek', label: '上周' },
            { value: 'thisMonth', label: '本月' },
            { value: 'lastMonth', label: '上月' },
            { value: 'custom', label: '自定义' }
        ]);
        dropdown.setValue('thisMonth');

        this.timeDisplay = row.createDiv('current-time-display');
        this.timeDisplay.addClass('hidden');
    }

    applyTimeRange(rangeKey: string): void {
        const now = new Date();
        let startDate: Date;
        let endDate: Date;
        let displayText: string;

        switch (rangeKey) {
            case 'thisWeek': {
                const day = now.getDay();
                const diff = now.getDate() - day + (day === 0 ? -6 : 1);
                startDate = new Date(now.setDate(diff));
                endDate = new Date(now.setDate(diff + 6));
                displayText = '本周';
                break;
            }
            case 'lastWeek': {
                const day = now.getDay();
                const diff = now.getDate() - day + (day === 0 ? -6 : 1) - 7;
                startDate = new Date(now.setDate(diff));
                endDate = new Date(now.setDate(diff + 6));
                displayText = '上周';
                break;
            }
            case 'thisMonth':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                displayText = '本月';
                break;
            case 'lastMonth':
                startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                endDate = new Date(now.getFullYear(), now.getMonth(), 0);
                displayText = '上月';
                break;
            case 'custom':
                this.showDateRangePicker();
                return;
            default:
                return;
        }

        const startStr = formatLocalDate(startDate);
        const endStr = formatLocalDate(endDate);
        this.currentDateRange = { start: startStr, end: endStr, label: displayText };

        this.timeDisplay.addClass('hidden');

        void this.loadStats();
    }

    showDateRangePicker(): void {
        new DateRangeModal(this.app, {
            onSelect: (startDate, endDate) => {
                this.currentDateRange = { start: startDate, end: endDate, label: '自定义' };

                this.timeDisplay.textContent = `${startDate} 至 ${endDate}`;
                this.timeDisplay.removeClass('hidden');

                void this.loadStats();
            }
        }).open();
    }

    async loadStats(forceRefresh = false): Promise<void> {
        try {
            const allRecords = await this.plugin.storage.getAllRecords(forceRefresh);
            let records = allRecords;

            // 默认按本月筛选；若用户已选择其他范围则按该范围
            if (this.currentDateRange.start && this.currentDateRange.end) {
                records = this.plugin.storage.filterRecordsByDateRange(
                    allRecords, this.currentDateRange.start, this.currentDateRange.end
                );
            } else {
                const now = new Date();
                const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                const startStr = formatLocalDate(startDate);
                const endStr = formatLocalDate(endDate);
                this.currentDateRange = { start: startStr, end: endStr, label: '本月' };
                records = this.plugin.storage.filterRecordsByDateRange(allRecords, startStr, endStr);
                this.timeDisplay.addClass('hidden');
            }

            const stats = this.plugin.storage.calculateStatistics(records);
            renderStatsInto(this.statsContainer, stats);
        } catch (error) {
            console.error('加载统计数据失败:', error);
            new Notice('加载统计数据失败');
        }
    }

    onClose(): Promise<void> {
        return Promise.resolve();
    }
}

// ── 批量重分类视图 ─────────────────────────────────────────────────────────────

class ReclassifyView extends ItemView {
    plugin: AccountingPlugin;

    // UI 状态
    rules: ReclassifyRule[] = [];
    previewResult: PreviewResult | null = null;
    selectedMatches: Set<ReclassifyMatch> = new Set();
    isLoading: boolean = false;
    dateFilterEnabled: boolean = false;
    startDate: string = '';
    endDate: string = '';

    // 批量改分类状态
    batchTimeRange: 'all' | 'thisMonth' | 'lastMonth' | 'last6Months' = 'all';
    batchCustomDateEnabled: boolean = false;
    batchStartDate: string = '';
    batchEndDate: string = '';
    batchFromKeywords: Set<string> = new Set();
    batchToKeyword: string = '';
    batchPreview: BatchCategoryPreview | null = null;
    selectedBatchMatches: Set<BatchCategoryMatch> = new Set();

    // 批量改分类 DOM 引用
    batchPreviewEl: HTMLElement;
    batchPreviewBtn: HTMLButtonElement;
    batchExecuteBtn: HTMLButtonElement;

    // DOM 引用
    ruleListEl: HTMLElement;
    previewEl: HTMLElement;
    previewBtn: HTMLButtonElement;
    executeBtn: HTMLButtonElement;

    constructor(leaf: WorkspaceLeaf, plugin: AccountingPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { return RECLASSIFY_VIEW; }
    getDisplayText(): string { return '批量重分类'; }
    getIcon(): string { return 'replace'; }

    // 任务 5.1：从 plugin.config.reclassifyRules 读取规则，若不存在则初始化为 []
    loadRules(): void {
        this.rules = this.plugin.config.reclassifyRules
            ? [...this.plugin.config.reclassifyRules]
            : [];
    }

    // 任务 5.2：读取 config.json，仅更新 reclassifyRules 字段，保留其他字段，写回文件
    async saveRules(): Promise<void> {
        try {
            const configPath = `${this.plugin.manifest.dir}/config.json`;
            const adapter = this.app.vault.adapter;

            // 读取现有 config.json 内容
            let existingConfig: Record<string, unknown> = {};
            if (await adapter.exists(configPath)) {
                const raw = await adapter.read(configPath);
                existingConfig = JSON.parse(raw) as Partial<AccountingConfig>;
            }

            // 仅更新 reclassifyRules 字段，保留其他字段
            existingConfig.reclassifyRules = this.rules;

            // 写回文件
            await adapter.write(configPath, JSON.stringify(existingConfig, null, 4));

            // 同步更新内存中的 plugin.config
            this.plugin.config.reclassifyRules = [...this.rules];
        } catch (error) {
            console.error('保存规则失败:', error);
            new Notice('保存规则失败');
        }
    }

    // 任务 6.1：渲染规则列表容器 ruleListEl 和「添加规则」按钮
    private renderRuleEditor(container: HTMLElement): void {
        const section = container.createDiv('reclassify-rule-editor');
        section.createEl('h3', { text: '重分类规则' });

        // 「添加规则」按钮
        const addBtn = section.createEl('button', {
            text: '+ 添加规则',
            cls: 'accounting-btn accounting-btn-primary'
        });
        addBtn.onclick = () => this.addRule();

        // 规则列表容器
        this.ruleListEl = section.createDiv('reclassify-rule-list');
        this.updateRuleList();
    }

    // 任务 6.2：渲染单条规则行
    private renderRuleRow(container: HTMLElement, index: number, rule: ReclassifyRule): void {
        const row = container.createDiv('reclassify-rule-row');

        // 备注关键词文本输入框
        const keywordInput = row.createEl('input', {
            type: 'text',
            cls: 'reclassify-keyword-input',
            attr: { placeholder: '如 maner' }
        });
        keywordInput.value = rule.keyword;
        keywordInput.oninput = () => {
            this.rules[index].keyword = keywordInput.value;
            void this.saveRules();
        };

        // 源分类下拉框已移除，默认「不限」（fromCategory 固定为空字符串）
        this.rules[index].fromCategory = '';

        // 目标分类下拉框（必填）
        const toSelect = row.createEl('select', { cls: 'reclassify-to-select' });
        // 添加空占位选项
        const placeholderOpt = toSelect.createEl('option', { text: '请选择目标分类', value: '' });
        placeholderOpt.disabled = true;
        recordEntries(this.plugin.config.categories).forEach(([keyword, categoryName]) => {
            const opt = toSelect.createEl('option', {
                text: `${categoryName} (${keyword})`,
                value: keyword
            });
            if (keyword === rule.toCategory) {
                opt.selected = true;
            }
        });
        if (!rule.toCategory) {
            placeholderOpt.selected = true;
        }
        toSelect.onchange = () => {
            this.rules[index].toCategory = toSelect.value;
            void this.saveRules();
        };

        // 删除按钮
        const deleteBtn = row.createEl('button', {
            text: '删除',
            cls: 'accounting-btn reclassify-delete-btn'
        });
        deleteBtn.onclick = () => this.deleteRule(index);

        // 自动分类复选框
        const autoLabel = row.createEl('label', { cls: 'reclassify-auto-label' });
        const autoCb = autoLabel.createEl('input', { type: 'checkbox' });
        autoCb.checked = rule.autoApply === true;
        autoLabel.appendText(' 自动');
        autoCb.onchange = () => {
            this.rules[index].autoApply = autoCb.checked;
            void this.saveRules();
        };

        // 重写备注输入框（可选，非空时替换原备注）
        const rewriteInput = row.createEl('input', {
            type: 'text',
            cls: 'reclassify-rewrite-input',
            attr: { placeholder: '重写备注（可选）' }
        });
        rewriteInput.value = rule.rewriteDescription || '';
        rewriteInput.oninput = () => {
            this.rules[index].rewriteDescription = rewriteInput.value;
            void this.saveRules();
        };
    }

    // 任务 6.3：添加规则
    private addRule(): void {
        this.rules.push({ keyword: '', fromCategory: '', toCategory: '' });
        this.updateRuleList();
        void this.saveRules();
    }

    // 任务 6.3：删除规则
    private deleteRule(index: number): void {
        this.rules.splice(index, 1);
        this.updateRuleList();
        void this.saveRules();
    }

    // 任务 6.3：重新渲染规则列表
    private updateRuleList(): void {
        if (!this.ruleListEl) return;
        this.ruleListEl.empty();

        if (this.rules.length === 0) {
            this.ruleListEl.createEl('p', {
                text: '点击「添加规则」开始配置',
                cls: 'reclassify-empty-hint'
            });
            return;
        }

        this.rules.forEach((rule, index) => {
            this.renderRuleRow(this.ruleListEl, index, rule);
        });
    }

    // 任务 7.1：渲染预览区容器和按钮
    private renderPreviewPanel(container: HTMLElement): void {
        const section = container.createDiv('reclassify-preview-panel');
        section.createEl('h3', { text: '预览结果' });

        // 按钮行
        const btnRow = section.createDiv('reclassify-btn-row');

        this.previewBtn = btnRow.createEl('button', {
            text: '预览',
            cls: 'accounting-btn accounting-btn-primary'
        });
        this.previewBtn.onclick = () => { void this.runPreview(); };

        this.executeBtn = btnRow.createEl('button', {
            text: '执行修改',
            cls: 'accounting-btn reclassify-execute-btn'
        });
        this.executeBtn.disabled = true;
        this.executeBtn.onclick = () => { void this.executeCommit(); };

        // 预览内容区
        this.previewEl = section.createDiv('reclassify-preview-content');
    }

    // 任务 10.3：校验日期范围
    private validateDateRange(startDate: string, endDate: string): string | null {
        if (!startDate || !endDate) return '请选择完整的日期范围';
        if (startDate > endDate) return '开始日期不能晚于结束日期';
        return null;
    }

    // 渲染批量改分类区域
    private renderBatchCategoryEditor(container: HTMLElement): void {
        const section = container.createDiv('reclassify-batch-editor');
        section.createEl('h3', { text: '批量改分类' });

        // 快捷时间选择
        const timeRow = section.createDiv('reclassify-batch-row');
        timeRow.createEl('label', { text: '时间范围：', cls: 'reclassify-batch-label' });
        const timeButtons = timeRow.createDiv('reclassify-batch-time-buttons');
        const timeRanges = [
            { key: 'all', label: '全部' },
            { key: 'thisMonth', label: '本月' },
            { key: 'lastMonth', label: '上月' },
            { key: 'last6Months', label: '最近六月' }
        ];
        let activeTimeBtn: HTMLElement | null = null;
        const setActiveTimeBtn = (btn: HTMLElement) => {
            if (activeTimeBtn) activeTimeBtn.removeClass('active');
            btn.addClass('active');
            activeTimeBtn = btn;
        };
        timeRanges.forEach(range => {
            const btn = timeButtons.createEl('button', {
                text: range.label,
                cls: 'reclassify-batch-time-btn'
            });
            btn.onclick = () => {
                this.batchTimeRange = range.key as BatchTimeRange;
                this.applyBatchTimeRange();
                setActiveTimeBtn(btn);
            };
            if (range.key === (this.batchTimeRange || 'all')) {
                setActiveTimeBtn(btn);
            }
        });

        // 自定义日期范围
        const customRow = section.createDiv('reclassify-batch-row');
        const customCbLabel = customRow.createEl('label', { cls: 'reclassify-batch-checkbox' });
        const customCb = customCbLabel.createEl('input', { type: 'checkbox' });
        customCbLabel.appendText(' 自定义日期');
        const customDates = customRow.createDiv('reclassify-batch-custom-dates reclassify-batch-custom-dates--hidden');
        customDates.createEl('label', { text: '开始' });
        const startInput = customDates.createEl('input', { type: 'date' });
        customDates.createEl('label', { text: '结束' });
        const endInput = customDates.createEl('input', { type: 'date' });

        customCb.onchange = () => {
            this.batchCustomDateEnabled = customCb.checked;
            customDates.toggleClass('reclassify-batch-custom-dates--hidden', !customCb.checked);
            if (customCb.checked && activeTimeBtn) {
                activeTimeBtn.removeClass('active');
                activeTimeBtn = null;
            }
        };
        startInput.onchange = () => { this.batchStartDate = startInput.value; };
        endInput.onchange = () => { this.batchEndDate = endInput.value; };

        // 源分类多选
        const fromRow = section.createDiv('reclassify-batch-row');
        fromRow.createEl('label', { text: '源分类：', cls: 'reclassify-batch-label' });
        const fromContainer = section.createDiv('reclassify-batch-from-categories');
        recordEntries(this.plugin.config.categories).forEach(([keyword, categoryName]) => {
            const label = fromContainer.createEl('label', { cls: 'reclassify-batch-category-pill' });
            const cb = label.createEl('input', { type: 'checkbox', value: keyword });
            label.appendText(` ${categoryName}`);
            cb.onchange = () => {
                if (cb.checked) {
                    this.batchFromKeywords.add(keyword);
                    label.addClass('active');
                } else {
                    this.batchFromKeywords.delete(keyword);
                    label.removeClass('active');
                }
            };
        });

        // 目标分类
        const toRow = section.createDiv('reclassify-batch-row');
        toRow.createEl('label', { text: '目标分类：', cls: 'reclassify-batch-label' });
        const toSelect = toRow.createEl('select', { cls: 'reclassify-batch-to-select' });
        const placeholderOpt = toSelect.createEl('option', { text: '请选择目标分类', value: '' });
        placeholderOpt.disabled = true;
        placeholderOpt.selected = true;
        recordEntries(this.plugin.config.categories).forEach(([keyword, categoryName]) => {
            toSelect.createEl('option', { text: `${categoryName} (${keyword})`, value: keyword });
        });
        toSelect.onchange = () => { this.batchToKeyword = toSelect.value; };

        // 按钮行
        const btnRow = section.createDiv('reclassify-batch-btn-row');
        this.batchPreviewBtn = btnRow.createEl('button', {
            text: '预览',
            cls: 'accounting-btn accounting-btn-primary'
        });
        this.batchPreviewBtn.onclick = () => { void this.runBatchCategoryPreview(); };

        this.batchExecuteBtn = btnRow.createEl('button', {
            text: '执行修改',
            cls: 'accounting-btn reclassify-execute-btn'
        });
        this.batchExecuteBtn.disabled = true;
        this.batchExecuteBtn.onclick = () => { void this.executeBatchCategoryCommit(); };

        // 预览内容区
        this.batchPreviewEl = section.createDiv('reclassify-batch-preview-content');
    }

    /** 应用批量改分类的快捷时间范围 */
    private applyBatchTimeRange(): void {
        const now = new Date();
        let startDate: Date;
        let endDate: Date;

        switch (this.batchTimeRange) {
            case 'thisMonth':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                break;
            case 'lastMonth':
                startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                endDate = new Date(now.getFullYear(), now.getMonth(), 0);
                break;
            case 'last6Months':
                startDate = new Date(now.getFullYear(), now.getMonth() - 5, 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                break;
            default:
                startDate = new Date(1970, 0, 1);
                endDate = new Date(2099, 11, 31);
        }

        this.batchStartDate = formatLocalDate(startDate);
        this.batchEndDate = formatLocalDate(endDate);
    }

    // 任务 10.1：渲染日期范围筛选区
    private renderDateFilter(container: HTMLElement): void {
        const section = container.createDiv('reclassify-date-filter');

        // 复选框行
        const checkboxRow = section.createDiv();
        const checkbox = checkboxRow.createEl('input', { type: 'checkbox' });
        checkbox.id = 'reclassify-date-filter-checkbox';
        checkboxRow.createEl('label', {
            text: ' 启用日期范围筛选',
            attr: { for: 'reclassify-date-filter-checkbox' }
        });

        // 日期输入区（默认隐藏）
        const dateInputs = section.createDiv('reclassify-date-inputs reclassify-date-inputs--hidden');

        dateInputs.createEl('label', { text: '开始日期：' });
        const startInput = dateInputs.createEl('input', { type: 'date' });
        startInput.value = this.startDate;

        dateInputs.createEl('label', { text: '结束日期：' });
        const endInput = dateInputs.createEl('input', { type: 'date' });
        endInput.value = this.endDate;

        // 复选框变化时显示/隐藏日期输入框
        checkbox.onchange = () => {
            this.dateFilterEnabled = checkbox.checked;
            dateInputs.toggleClass('reclassify-date-inputs--hidden', !checkbox.checked);
        };

        // 日期变化时更新状态
        startInput.onchange = () => {
            this.startDate = startInput.value;
        };
        endInput.onchange = () => {
            this.endDate = endInput.value;
        };
    }

    // 任务 7.2：执行预览
    private async runPreview(): Promise<void> {
        // 校验规则
        const errors = ReclassifyEngine.validateRules(this.rules);
        if (errors.length > 0) {
            this.previewEl.empty();
            const errContainer = this.previewEl.createDiv('reclassify-errors');
            errors.forEach(err => {
                errContainer.createEl('p', {
                    text: err.message,
                    cls: 'reclassify-error-msg'
                });
            });
            return;
        }

        // 设置加载状态
        this.isLoading = true;
        this.previewBtn.disabled = true;
        this.executeBtn.disabled = true;
        this.previewEl.empty();
        this.previewEl.createEl('p', { text: '正在扫描记录...', cls: 'reclassify-loading' });

        try {
            // 获取所有记录
            let records = await this.plugin.storage.getAllRecords();

            // 日期范围过滤（如果启用）
            if (this.dateFilterEnabled && this.startDate && this.endDate) {
                // 任务 10.2：先校验日期范围
                const dateError = this.validateDateRange(this.startDate, this.endDate);
                if (dateError) {
                    this.previewEl.empty();
                    this.previewEl.createEl('p', {
                        text: dateError,
                        cls: 'reclassify-error-msg'
                    });
                    return;
                }
                records = this.plugin.storage.filterRecordsByDateRange(records, this.startDate, this.endDate);
            }

            // 执行 dry run
            this.previewResult = ReclassifyEngine.dryRun(
                this.rules,
                records,
                this.plugin.config.expenseEmoji,
                this.plugin.config.journalsPath,
                this.plugin.config.dateFormat
            );

            // 渲染预览结果
            this.renderPreviewResult();
        } catch (error) {
            console.error('预览失败:', error);
            this.previewEl.empty();
            this.previewEl.createEl('p', { text: '预览失败，请重试', cls: 'reclassify-error-msg' });
        } finally {
            this.isLoading = false;
            this.previewBtn.disabled = false;
        }
    }

    // 任务 7.3：渲染预览结果（含逐行勾选）
    private renderPreviewResult(): void {
        this.previewEl.empty();

        if (!this.previewResult) return;

        const { matches, totalCount, fileCount } = this.previewResult;

        if (totalCount === 0) {
            this.previewEl.createEl('p', {
                text: '未找到匹配记录，请检查规则配置',
                cls: 'reclassify-no-match'
            });
            this.executeBtn.disabled = true;
            return;
        }

        // 默认全部勾选
        this.selectedMatches = new Set(matches);

        // 更新执行按钮状态的辅助函数
        const updateExecuteBtn = () => {
            this.executeBtn.disabled = this.selectedMatches.size === 0;
            summaryText.textContent = `共匹配 ${totalCount} 条记录，涉及 ${fileCount} 个文件，已选 ${this.selectedMatches.size} 条`;
        };

        // 顶部汇总
        const summary = this.previewEl.createDiv('reclassify-summary');
        const summaryText = summary.createEl('p', {
            text: `共匹配 ${totalCount} 条记录，涉及 ${fileCount} 个文件，已选 ${totalCount} 条`,
            cls: 'reclassify-summary-text'
        });

        // 按规则分组展示
        const ruleGroups = new Map<number, ReclassifyMatch[]>();
        for (const match of matches) {
            const ruleIndex = this.rules.indexOf(match.rule);
            const key = ruleIndex >= 0 ? ruleIndex : -1;
            if (!ruleGroups.has(key)) ruleGroups.set(key, []);
            ruleGroups.get(key)!.push(match);
        }

        ruleGroups.forEach((groupMatches, ruleIndex) => {
            const rule = ruleIndex >= 0 ? this.rules[ruleIndex] : groupMatches[0].rule;
            const fromLabel = rule.fromCategory
                ? (this.plugin.config.categories[rule.fromCategory] || rule.fromCategory)
                : '不限';
            const toLabel = this.plugin.config.categories[rule.toCategory] || rule.toCategory;

            const groupEl = this.previewEl.createDiv('reclassify-group');
            const groupHeader = groupEl.createDiv('reclassify-group-header');
            groupHeader.createEl('strong', {
                text: `规则：关键词「${rule.keyword}」 ${fromLabel} → ${toLabel}（${groupMatches.length} 条）`
            });

            const table = groupEl.createEl('table', { cls: 'reclassify-preview-table' });
            const thead = table.createEl('thead');
            const headerRow = thead.createEl('tr');

            // 表头全选复选框
            const thCheck = headerRow.createEl('th');
            const selectAllCb = thCheck.createEl('input', { type: 'checkbox' });
            selectAllCb.checked = true;
            selectAllCb.title = '全选/取消全选本组';

            ['日期', '原始分类', '备注', '金额', '修改后分类', '修改后备注'].forEach(col => {
                headerRow.createEl('th', { text: col });
            });

            const tbody = table.createEl('tbody');
            const rowCheckboxes: HTMLInputElement[] = [];

            groupMatches.forEach(match => {
                const tr = tbody.createEl('tr');
                const origCategory = this.plugin.config.categories[match.record.keyword] || match.record.keyword;
                const newCategory = this.plugin.config.categories[match.rule.toCategory] || match.rule.toCategory;

                // 行勾选框
                const tdCheck = tr.createEl('td');
                const rowCb = tdCheck.createEl('input', { type: 'checkbox' });
                rowCb.checked = true;
                rowCheckboxes.push(rowCb);

                rowCb.onchange = () => {
                    if (rowCb.checked) {
                        this.selectedMatches.add(match);
                        tr.removeClass('reclassify-row-deselected');
                    } else {
                        this.selectedMatches.delete(match);
                        tr.addClass('reclassify-row-deselected');
                    }
                    // 同步全选框状态
                    const checkedCount = rowCheckboxes.filter(cb => cb.checked).length;
                    selectAllCb.checked = checkedCount === rowCheckboxes.length;
                    selectAllCb.indeterminate = checkedCount > 0 && checkedCount < rowCheckboxes.length;
                    updateExecuteBtn();
                };

                tr.createEl('td', { text: match.record.date });
                tr.createEl('td', { text: origCategory });
                tr.createEl('td', { text: match.record.description || '-' });
                tr.createEl('td', { text: `¥${match.record.amount.toFixed(2)}` });
                tr.createEl('td', { text: newCategory, cls: 'reclassify-new-category' });
                // 修改后备注：有重写规则且与原备注不同时高亮显示
                const newDesc = match.rule.rewriteDescription?.trim();
                const descCell = tr.createEl('td');
                if (newDesc && newDesc !== match.record.description) {
                    descCell.textContent = newDesc;
                    descCell.addClass('reclassify-new-category');
                } else {
                    descCell.textContent = '-';
                    descCell.addClass('reclassify-muted');
                }
            });

            // 全选复选框逻辑
            selectAllCb.onchange = () => {
                rowCheckboxes.forEach((cb, i) => {
                    cb.checked = selectAllCb.checked;
                    const match = groupMatches[i];
                    const tr = cb.closest('tr') as HTMLElement;
                    if (selectAllCb.checked) {
                        this.selectedMatches.add(match);
                        tr?.removeClass('reclassify-row-deselected');
                    } else {
                        this.selectedMatches.delete(match);
                        tr?.addClass('reclassify-row-deselected');
                    }
                });
                selectAllCb.indeterminate = false;
                updateExecuteBtn();
            };
        });

        // 有匹配时启用「执行修改」按钮
        this.executeBtn.disabled = false;
    }

    // 任务 8.3：执行 commit（带确认弹窗，只提交勾选的记录）
    private async executeCommit(): Promise<void> {
        if (!this.previewResult || this.selectedMatches.size === 0) return;

        const selectedList = Array.from(this.selectedMatches);
        const selectedCount = selectedList.length;
        const selectedFileCount = new Set(selectedList.map(m => m.filePath)).size;

        // 使用 Modal 实现确认对话框
        await new Promise<void>((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText('确认批量修改');
            modal.contentEl.createEl('p', {
                text: `将修改 ${selectedCount} 条记录，涉及 ${selectedFileCount} 个文件，此操作不可撤销，确认继续？`
            });

            const btnRow = modal.contentEl.createDiv({ cls: 'modal-button-container' });

            const confirmBtn = btnRow.createEl('button', {
                text: '确认',
                cls: 'mod-cta'
            });
            confirmBtn.onclick = async () => {
                modal.close();

                try {
                    // 只提交勾选的记录
                    const partialResult: PreviewResult = {
                        matches: selectedList,
                        totalCount: selectedCount,
                        fileCount: selectedFileCount,
                    };
                    await ReclassifyEngine.commit(this.app, partialResult);

                    new Notice(`批量修改完成：已修改 ${selectedCount} 条记录，涉及 ${selectedFileCount} 个文件`);

                    this.plugin.storage.clearCache();

                    this.previewResult = null;
                    this.selectedMatches = new Set();
                    this.executeBtn.disabled = true;
                    this.previewEl.empty();
                    this.previewEl.createEl('p', {
                        text: '修改完成，可重新点击「预览」查看最新数据',
                        cls: 'reclassify-done-hint'
                    });
                } catch (error) {
                    console.error('批量修改失败:', error);
                    new Notice('批量修改失败，请重试');
                }

                resolve();
            };

            const cancelBtn = btnRow.createEl('button', { text: '取消' });
            cancelBtn.onclick = () => {
                modal.close();
                resolve();
            };

            modal.open();
        });
    }

    // 批量改分类：执行预览
    private async runBatchCategoryPreview(): Promise<void> {
        if (this.batchFromKeywords.size === 0) {
            this.batchPreviewEl.empty();
            this.batchPreviewEl.createEl('p', { text: '请至少选择一个源分类', cls: 'reclassify-error-msg' });
            return;
        }
        if (!this.batchToKeyword) {
            this.batchPreviewEl.empty();
            this.batchPreviewEl.createEl('p', { text: '请选择目标分类', cls: 'reclassify-error-msg' });
            return;
        }

        let startDate = this.batchStartDate;
        let endDate = this.batchEndDate;
        if (this.batchCustomDateEnabled) {
            const dateError = this.validateDateRange(startDate, endDate);
            if (dateError) {
                this.batchPreviewEl.empty();
                this.batchPreviewEl.createEl('p', { text: dateError, cls: 'reclassify-error-msg' });
                return;
            }
        } else if (!startDate || !endDate) {
            this.applyBatchTimeRange();
            startDate = this.batchStartDate;
            endDate = this.batchEndDate;
        }

        this.batchPreviewBtn.disabled = true;
        this.batchExecuteBtn.disabled = true;
        this.batchPreviewEl.empty();
        this.batchPreviewEl.createEl('p', { text: '正在扫描记录...', cls: 'reclassify-loading' });

        try {
            const records = await this.plugin.storage.getAllRecords();
            this.batchPreview = ReclassifyEngine.batchCategoryDryRun(
                records,
                startDate,
                endDate,
                Array.from(this.batchFromKeywords),
                this.batchToKeyword,
                this.plugin.config.expenseEmoji,
                this.plugin.config.journalsPath,
                this.plugin.config.dateFormat
            );
            this.renderBatchCategoryPreview();
        } catch (error) {
            console.error('批量改分类预览失败:', error);
            this.batchPreviewEl.empty();
            this.batchPreviewEl.createEl('p', { text: '预览失败，请重试', cls: 'reclassify-error-msg' });
        } finally {
            this.batchPreviewBtn.disabled = false;
        }
    }

    // 批量改分类：渲染预览结果
    private renderBatchCategoryPreview(): void {
        this.batchPreviewEl.empty();
        this.selectedBatchMatches = new Set();

        if (!this.batchPreview) return;
        const { matches, totalCount, fileCount } = this.batchPreview;

        if (totalCount === 0) {
            this.batchPreviewEl.createEl('p', { text: '未找到匹配记录', cls: 'reclassify-no-match' });
            this.batchExecuteBtn.disabled = true;
            return;
        }

        this.selectedBatchMatches = new Set(matches);

        const summary = this.batchPreviewEl.createDiv('reclassify-summary');
        const summaryText = summary.createEl('p', {
            text: `共匹配 ${totalCount} 条记录，涉及 ${fileCount} 个文件，已选 ${totalCount} 条`,
            cls: 'reclassify-summary-text'
        });

        const updateExecuteBtn = () => {
            this.batchExecuteBtn.disabled = this.selectedBatchMatches.size === 0;
            summaryText.textContent = `共匹配 ${totalCount} 条记录，涉及 ${fileCount} 个文件，已选 ${this.selectedBatchMatches.size} 条`;
        };

        const table = this.batchPreviewEl.createEl('table', { cls: 'reclassify-preview-table' });
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        const thCheck = headerRow.createEl('th');
        const selectAllCb = thCheck.createEl('input', { type: 'checkbox' });
        selectAllCb.checked = true;
        ['日期', '原始分类', '备注', '金额', '修改后分类'].forEach(col => {
            headerRow.createEl('th', { text: col });
        });

        const tbody = table.createEl('tbody');
        const rowCheckboxes: HTMLInputElement[] = [];

        matches.forEach(match => {
            const tr = tbody.createEl('tr');
            const origCategory = this.plugin.config.categories[match.record.keyword] || match.record.keyword;
            const newCategory = this.plugin.config.categories[match.toCategory] || match.toCategory;

            const tdCheck = tr.createEl('td');
            const rowCb = tdCheck.createEl('input', { type: 'checkbox' });
            rowCb.checked = true;
            rowCheckboxes.push(rowCb);

            rowCb.onchange = () => {
                if (rowCb.checked) {
                    this.selectedBatchMatches.add(match);
                    tr.removeClass('reclassify-row-deselected');
                } else {
                    this.selectedBatchMatches.delete(match);
                    tr.addClass('reclassify-row-deselected');
                }
                const checkedCount = rowCheckboxes.filter(cb => cb.checked).length;
                selectAllCb.checked = checkedCount === rowCheckboxes.length;
                selectAllCb.indeterminate = checkedCount > 0 && checkedCount < rowCheckboxes.length;
                updateExecuteBtn();
            };

            tr.createEl('td', { text: match.record.date });
            tr.createEl('td', { text: origCategory });
            tr.createEl('td', { text: match.record.description || '-' });
            tr.createEl('td', { text: `¥${match.record.amount.toFixed(2)}` });
            tr.createEl('td', { text: newCategory, cls: 'reclassify-new-category' });
        });

        selectAllCb.onchange = () => {
            rowCheckboxes.forEach((cb, i) => {
                cb.checked = selectAllCb.checked;
                const match = matches[i];
                const tr = cb.closest('tr') as HTMLElement;
                if (selectAllCb.checked) {
                    this.selectedBatchMatches.add(match);
                    tr?.removeClass('reclassify-row-deselected');
                } else {
                    this.selectedBatchMatches.delete(match);
                    tr?.addClass('reclassify-row-deselected');
                }
            });
            selectAllCb.indeterminate = false;
            updateExecuteBtn();
        };

        this.batchExecuteBtn.disabled = false;
    }

    // 批量改分类：执行修改
    private async executeBatchCategoryCommit(): Promise<void> {
        if (!this.batchPreview || this.selectedBatchMatches.size === 0) return;

        const selectedList = Array.from(this.selectedBatchMatches);
        const selectedCount = selectedList.length;
        const selectedFileCount = new Set(selectedList.map(m => m.filePath)).size;

        await new Promise<void>((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText('确认批量修改');
            modal.contentEl.createEl('p', {
                text: `将修改 ${selectedCount} 条记录，涉及 ${selectedFileCount} 个文件，此操作不可撤销，确认继续？`
            });

            const btnRow = modal.contentEl.createDiv({ cls: 'modal-button-container' });

            const confirmBtn = btnRow.createEl('button', { text: '确认', cls: 'mod-cta' });
            confirmBtn.onclick = async () => {
                modal.close();
                try {
                    const fileGroups = new Map<string, BatchCategoryMatch[]>();
                    for (const match of selectedList) {
                        if (!fileGroups.has(match.filePath)) {
                            fileGroups.set(match.filePath, []);
                        }
                        fileGroups.get(match.filePath)!.push(match);
                    }

                    const failedFiles: string[] = [];
                    for (const [filePath, fileMatches] of fileGroups) {
                        try {
                            const file = this.app.vault.getAbstractFileByPath(filePath);
                            if (!(file instanceof TFile)) {
                                failedFiles.push(filePath);
                                continue;
                            }
                            let content = await this.app.vault.read(file);
                            const originalContent = content;
                            for (const match of fileMatches) {
                                content = content.replace(match.record.rawLine, match.newRawLine);
                            }
                            if (content !== originalContent) {
                                await this.app.vault.modify(file, content);
                            }
                        } catch {
                            failedFiles.push(filePath);
                        }
                    }

                    if (failedFiles.length > 0) {
                        new Notice(`${failedFiles.length} 个文件写入失败`);
                    } else {
                        new Notice(`批量修改完成：已修改 ${selectedCount} 条记录`);
                    }

                    this.plugin.storage.clearCache();
                    this.batchPreview = null;
                    this.selectedBatchMatches = new Set();
                    this.batchExecuteBtn.disabled = true;
                    this.batchPreviewEl.empty();
                    this.batchPreviewEl.createEl('p', {
                        text: '修改完成，可重新点击「预览」查看最新数据',
                        cls: 'reclassify-done-hint'
                    });
                } catch (error) {
                    console.error('批量改分类执行失败:', error);
                    new Notice('批量修改失败，请重试');
                }
                resolve();
            };

            const cancelBtn = btnRow.createEl('button', { text: '取消' });
            cancelBtn.onclick = () => {
                modal.close();
                resolve();
            };

            modal.open();
        });
    }

    // 渲染页面头部
    private renderHeader(container: HTMLElement): void {
        const header = container.createDiv('reclassify-header');
        const appName = this.plugin.config.appName || '每日记账';
        header.createEl('h2', {
            text: `批量重分类 - ${appName}`,
            cls: 'reclassify-title'
        });
    }

	    onOpen(): Promise<void> {
	        const container = this.containerEl.children[1] as HTMLElement;
	        container.empty();
	        container.addClass('reclassify-view');

	        this.loadRules();
	        this.renderHeader(container);
	        this.renderRuleEditor(container);
	        this.renderBatchCategoryEditor(container);
	        this.renderDateFilter(container);
	        this.renderPreviewPanel(container);
	        return Promise.resolve();
	    }

	    onClose(): Promise<void> {
	        // 清理 DOM 引用（Obsidian 会自动清理 containerEl）
	        return Promise.resolve();
	    }
}
