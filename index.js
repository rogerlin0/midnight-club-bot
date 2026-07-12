// ============================================================
// 🌙 午夜俱樂部 MK-01 自動接單系統 v3.3
// Discord Bot + Telegram + 網站 API + 每日報表
// + 驗證系統 + 排行榜 + 工單 + 每日優惠 + VIP升級公告
// + VIP查詢API + 即時訂單API + 8591報價同步
// ============================================================

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle } = require('discord.js');
const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const mongoose = require('mongoose');
const line = require('@line/bot-sdk');

// ── 環境變數 ──
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_ADMIN_ID = process.env.LINE_ADMIN_USER_ID;
const PORT = process.env.PORT || 3000;

// ── LINE Client ──
const lineConfig = { channelAccessToken: LINE_TOKEN || '', channelSecret: LINE_SECRET || '' };
const lineClient = LINE_TOKEN ? new line.messagingApi.MessagingApiClient({ channelAccessToken: LINE_TOKEN }) : null;

// ══════════════════════════════════════════
// MongoDB Schemas
// ══════════════════════════════════════════
const orderSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  serviceCode: String, serviceName: String, price: Number,
  originalPrice: Number, guarantee: String,
  quantity: { type: Number, default: 1 },
  paidQuantity: { type: Number, default: 1 },
  freeQuantity: { type: Number, default: 0 },
  gameId: String, contactId: String, airplane: String,
  map: String, note: String, customerName: String,
  status: { type: String, default: 'pending', index: true },
  booster: String, boosterId: String,
  acceptedAt: String, completedAt: String, createdAt: String,
  referralCode: String,
  vipTier: String, vipDiscount: Number,
});

const vipSchema = new mongoose.Schema({
  contactId: { type: String, unique: true, index: true },
  name: String, totalSpent: { type: Number, default: 0 },
  orders: [{ id: String, service: String, price: Number, date: String }],
});

const boosterSchema = new mongoose.Schema({
  tag: { type: String, unique: true, index: true },
  completed: { type: Number, default: 0 },
  revenue: { type: Number, default: 0 },
  name: String,
});

const ticketSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  userId: String, userTag: String, description: String,
  status: { type: String, default: 'open' },
  createdAt: String, responses: Array,
});

const counterSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: { type: Number, default: 0 },
});

const referralSchema = new mongoose.Schema({
  code: { type: String, unique: true, index: true },
  ownerId: String, ownerName: String,
  referred: [{ contactId: String, name: String, date: String, orderAmount: Number }],
  totalReferred: { type: Number, default: 0 },
  milestone: Object, coupons: Array, permDiscount: Number,
  createdAt: String,
});

const boosterRegSchema = new mongoose.Schema({
  name: { type: String, unique: true, index: true },
  discordId: String,
});

const custThreadSchema = new mongoose.Schema({
  contactId: { type: String, unique: true, index: true },
  threadId: String,
});

let Order, Vip, Booster, Ticket, Counter, Referral, BoosterReg, CustThread;
let mongoReady = false;

// ── 記憶體 fallback（MongoDB 連不上時使用） ──
const orders = new Map();
const orderMessages = new Map();
let orderCounter = 1000;
const dailyStats = { revenue: 0, count: 0, services: {} };
const vipData = new Map();
const boosterStats = new Map();
const boosterRegistry = new Map(); // 打手名 → Discord ID（指定接單用）
const customerThreads = new Map(); // 聯繫ID → 客戶紀錄討論串ID
const tickets = new Map();
let ticketCounter = 0;
const referrals = new Map();
const referralByContact = new Map();

// ── MongoDB 連線 ──
async function connectMongo() {
  if (!MONGO_URI) { console.log('⚠️ 未設定 MONGO_URI，使用記憶體模式'); return; }
  try {
    await mongoose.connect(MONGO_URI);
    Order = mongoose.model('Order', orderSchema);
    Vip = mongoose.model('Vip', vipSchema);
    Booster = mongoose.model('Booster', boosterSchema);
    Ticket = mongoose.model('Ticket', ticketSchema);
    Counter = mongoose.model('Counter', counterSchema);
    Referral = mongoose.model('Referral', referralSchema);
    BoosterReg = mongoose.model('BoosterReg', boosterRegSchema);
    CustThread = mongoose.model('CustThread', custThreadSchema);

    // 載入 counter
    const oc = await Counter.findOne({ key: 'order' });
    if (oc) orderCounter = oc.value;
    const tc = await Counter.findOne({ key: 'ticket' });
    if (tc) ticketCounter = tc.value;

    // 載入現有資料到記憶體快取（Discord bot 需要）
    const allOrders = await Order.find({});
    allOrders.forEach(o => orders.set(o.id, o.toObject()));
    const allVip = await Vip.find({});
    allVip.forEach(v => vipData.set(v.contactId, v.toObject()));
    const allBoosters = await Booster.find({});
    allBoosters.forEach(b => boosterStats.set(b.tag, { completed: b.completed, revenue: b.revenue, name: b.name }));
    const allTickets = await Ticket.find({});
    allTickets.forEach(t => tickets.set(t.id, t.toObject()));
    const allReferrals = await Referral.find({});
    allReferrals.forEach(r => {
      referrals.set(r.code, r.toObject());
      referralByContact.set(r.ownerId, r.code);
    });
    const allRegs = await BoosterReg.find({});
    allRegs.forEach(b => boosterRegistry.set(b.name, b.discordId));
    const allCT = await CustThread.find({});
    allCT.forEach(c => customerThreads.set(c.contactId, c.threadId));

    mongoReady = true;
    console.log(`✅ MongoDB 已連線 — 載入 ${allOrders.length} 訂單, ${allVip.length} VIP, ${allBoosters.length} 打手`);
  } catch (e) {
    console.error('❌ MongoDB 連線失敗，使用記憶體模式:', e.message);
  }
}

// ── DB 寫入工具（同時寫記憶體 + MongoDB） ──
async function dbSaveOrder(order) {
  orders.set(order.id, order);
  if (mongoReady) {
    await Order.findOneAndUpdate({ id: order.id }, order, { upsert: true }).catch(e => console.error('DB save order err:', e.message));
    await Counter.findOneAndUpdate({ key: 'order' }, { value: orderCounter }, { upsert: true }).catch(() => {});
  }
}
async function dbSaveVip(contactId, data) {
  vipData.set(contactId, data);
  if (mongoReady) {
    await Vip.findOneAndUpdate({ contactId }, data, { upsert: true }).catch(e => console.error('DB save vip err:', e.message));
  }
}
async function dbSaveBooster(tag, data) {
  boosterStats.set(tag, data);
  if (mongoReady) {
    await Booster.findOneAndUpdate({ tag }, { ...data, tag }, { upsert: true }).catch(e => console.error('DB save booster err:', e.message));
  }
}
async function dbSaveTicket(ticket) {
  tickets.set(ticket.id, ticket);
  if (mongoReady) {
    await Ticket.findOneAndUpdate({ id: ticket.id }, ticket, { upsert: true }).catch(e => console.error('DB save ticket err:', e.message));
    await Counter.findOneAndUpdate({ key: 'ticket' }, { value: ticketCounter }, { upsert: true }).catch(() => {});
  }
}
async function dbSaveReferral(code, data) {
  referrals.set(code, data);
  referralByContact.set(data.ownerId, code);
  if (mongoReady) {
    await Referral.findOneAndUpdate({ code }, data, { upsert: true }).catch(e => console.error('DB save referral err:', e.message));
  }
}
const BOOSTER_NAMES = ['午夜人','1號猴','CANDY','NICK','狗一波','溜溜'];
async function dbSaveBoosterReg(name, discordId) {
  boosterRegistry.set(name, discordId);
  if (mongoReady) {
    await BoosterReg.findOneAndUpdate({ name }, { name, discordId }, { upsert: true }).catch(e => console.error('DB save boosterReg err:', e.message));
  }
}
async function dbSaveCustThread(contactId, threadId) {
  customerThreads.set(contactId, threadId);
  if (mongoReady) {
    await CustThread.findOneAndUpdate({ contactId }, { contactId, threadId }, { upsert: true }).catch(e => console.error('DB save custThread err:', e.message));
  }
}
// 核准入帳時：把訂單記進該客戶的專屬討論串（內部帳本，僅老闆/打手可見）
async function logCustomerOrder(guild, order) {
  try {
    if (!guild || !channels.custLedger || !order.contactId || order.contactId === '未填') return;
    const parent = guild.channels.cache.get(channels.custLedger);
    if (!parent) return;
    let thread = customerThreads.get(order.contactId) ? await parent.threads.fetch(customerThreads.get(order.contactId)).catch(() => null) : null;
    if (!thread) {
      thread = await parent.threads.create({ name: `🧾 ${(order.customerName || order.contactId).slice(0, 40)}`, autoArchiveDuration: 10080, reason: '客戶訂單紀錄' });
      await dbSaveCustThread(order.contactId, thread.id);
      await thread.send(`📒 **客戶專屬紀錄** — 聯繫ID：\`${order.contactId}\``);
    }
    const vip = vipData.get(order.contactId);
    const total = vip ? vip.totalSpent : order.price;
    const cnt = vip && vip.orders ? vip.orders.length : 1;
    const tier = getVipTier(total);
    const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle(`✅ ${order.id} ${order.serviceName}`)
      .addFields(
        { name: '金額', value: `${order.price} T`, inline: true },
        { name: '打手', value: order.booster || '—', inline: true },
        { name: '日期', value: new Date(order.completedAt).toLocaleString('zh-TW'), inline: true },
        { name: '累計消費', value: `${total.toLocaleString()} T`, inline: true },
        { name: 'VIP', value: `${tier.emoji || ''} ${tier.name}`, inline: true },
        { name: '累計訂單', value: `${cnt} 筆`, inline: true },
      ).setTimestamp();
    await thread.send({ embeds: [embed] });
  } catch (e) { console.error('logCustomerOrder err:', e.message); }
}

// ── 推薦里程碑定義 ──
const REFERRAL_MILESTONES = [
  { count: 1,  name: '🌱 入門推薦人', reward: '100T 折抵券', rewardT: 100 },
  { count: 3,  name: '⭐ 暗區引路人', reward: '扶貧單 A 免費一次（350T）', rewardT: 350, freeService: 'W-1' },
  { count: 5,  name: '🔥 午夜傳教士', reward: '護航① 免費一次（750T）+ VIP累計+2000T', rewardT: 750, freeService: 'E-1', vipBonus: 2000 },
  { count: 10, name: '👑 暗區教父', reward: '永久9折 + 護航③ 免費（1700T）+ Discord專屬角色', rewardT: 1700, freeService: 'E-3', permDiscount: 0.90 },
];

function generateReferralCode(name) {
  const prefix = (name || 'MC').replace(/[^a-zA-Z0-9一-鿿]/g, '').slice(0, 4).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `REF-${prefix}-${rand}`;
}

function checkMilestone(referralData) {
  const count = referralData.totalReferred;
  // 找到最高已達成的里程碑
  let reached = null;
  for (const m of REFERRAL_MILESTONES) {
    if (count >= m.count) reached = m;
  }
  return reached;
}

// ── 頻道 ID 快取 ──
const channels = {};

// ── 服務報價表 ──
const SERVICES = {
  // 護航・計算總價（保底×0.4）
  'H-01': { name: '護航 1000萬', price: 400, guarantee: '1,000萬', cat: '護航' },
  'H-02': { name: '護航 2000萬', price: 800, guarantee: '2,000萬', cat: '護航' },
  'H-03': { name: '護航 3000萬', price: 1200, guarantee: '3,000萬', cat: '護航' },
  'H-04': { name: '護航 4000萬', price: 1600, guarantee: '4,000萬', cat: '護航' },
  'H-05': { name: '護航 5000萬', price: 2000, guarantee: '5,000萬', cat: '護航' },
  'H-06': { name: '護航 8000萬', price: 3200, guarantee: '8,000萬', cat: '護航' },
  'H-07': { name: '護航 1億', price: 4000, guarantee: '1億', cat: '護航' },
  'H-08': { name: '護航 1.5億', price: 6000, guarantee: '1.5億', cat: '護航' },
  'H-09': { name: '護航 2億', price: 8000, guarantee: '2億', cat: '護航' },
  'H-10': { name: '護航 3億', price: 12000, guarantee: '3億', cat: '護航' },
  'H-11': { name: '護航 5億', price: 20000, guarantee: '5億', cat: '護航' },
  'H-12': { name: '護航 8億', price: 32000, guarantee: '8億', cat: '護航' },
  'H-13': { name: '護航 10億', price: 40000, guarantee: '10億', cat: '護航' },
  // 護航・單局撤離
  'R-1': { name: '單局撤離 300萬', price: 400, guarantee: '300萬', cat: '護航' },
  'R-2': { name: '單局撤離 500萬', price: 500, guarantee: '500萬', cat: '護航' },
  'R-3': { name: '單局撤離 700萬', price: 800, guarantee: '700萬', cat: '護航' },
  'R-4': { name: '單局撤離 1000萬', price: 1200, guarantee: '1,000萬', cat: '護航' },
  'R-5': { name: '單局撤離 1300萬', price: 3000, guarantee: '1,300萬', cat: '護航' },
  'R-6': { name: '護航包 3H', price: 3600, guarantee: null, cat: '護航' },
  // 清圖
  'C-1': { name: '電台清圖', price: 520, guarantee: null, cat: '清圖' },
  'C-2': { name: '王牌清圖', price: 1000, guarantee: null, cat: '清圖' },
  'C-3': { name: '主教練上場', price: 1200, guarantee: null, cat: '清圖' },
  'C-4': { name: '全地圖通清套餐', price: 4200, guarantee: null, cat: '清圖' },
  'C-5': { name: '清圖月卡', price: 12000, guarantee: null, cat: '清圖' },
  // 摸保險
  'I-1': { name: '摸保險 10個', price: 800, guarantee: '1,000萬', cat: '摸保險' },
  'I-2': { name: '摸保險 30個', price: 2400, guarantee: '2,800萬', cat: '摸保險' },
  'I-3': { name: '摸保險 50個', price: 4000, guarantee: '4,500萬', cat: '摸保險' },
  'I-4': { name: '摸保險 100個', price: 7000, guarantee: '8,000萬', cat: '摸保險' },
  'I-5': { name: '摸保險 200個', price: 13000, guarantee: '1.6億', cat: '摸保險' },
  // 對賭
  'G-1': { name: '單局單大金', price: 550, guarantee: null, cat: '對賭' },
  'G-2': { name: '指定任意大金', price: 5400, guarantee: null, cat: '對賭' },
  'G-3': { name: '雙大金保險局', price: 2200, guarantee: null, cat: '對賭' },
  'G-5': { name: '絕命大金單(只要大金)', price: 300, guarantee: null, cat: '對賭' },
  // 特殊地圖
  'S-1': { name: '機密文件', price: 4100, guarantee: '6,888萬', cat: '特殊地圖' },
  'S-2': { name: '理想國', price: 2680, guarantee: '3,999萬', cat: '特殊地圖' },
  'S-3': { name: '前線要塞通關', price: 1500, guarantee: null, cat: '特殊地圖' },
  'S-4': { name: '北山深入護送', price: 1800, guarantee: null, cat: '特殊地圖' },
  'S-5': { name: '五大地圖全制霸', price: 11000, guarantee: null, cat: '特殊地圖' },
  // 代肝
  'A-1': { name: 'S6 3x3代肝', price: 2800, guarantee: null, cat: '代肝' },
  'A-2': { name: '五天託管代肝', price: 7500, guarantee: null, cat: '代肝' },
  'A-4': { name: '聲望/等級代練', price: 600, guarantee: null, cat: '代肝' },
  // 陪玩
  'P-1': { name: '技術男陪/H', price: 350, guarantee: null, cat: '陪玩' },
  'P-2': { name: '娛樂女陪/H', price: 400, guarantee: null, cat: '陪玩' },
  'P-5': { name: '技術女陪/H', price: 600, guarantee: null, cat: '陪玩' },
  'P-6': { name: 'TW女陪/H', price: 450, guarantee: null, cat: '陪玩' },
  'P-7': { name: '雙排三排陪打/H', price: 320, guarantee: null, cat: '陪玩' },
  'P-8': { name: '新手教學帶飛/H', price: 500, guarantee: null, cat: '陪玩' },
  'P-3': { name: '長時陪做套餐', price: 3688, guarantee: null, cat: '陪玩' },
  'P-4': { name: '任務救急', price: 260, guarantee: null, cat: '陪玩' },
  // 配裝改槍
  'B-1': { name: '武器改裝配槍', price: 150, guarantee: null, cat: '配裝' },
  'B-2': { name: '全套配裝實裝', price: 450, guarantee: null, cat: '配裝' },
  'B-3': { name: '一對一打法教學/H', price: 500, guarantee: null, cat: '配裝' },
  'B-4': { name: '地圖點位路線教學', price: 350, guarantee: null, cat: '配裝' },
  // 扶貧單
  'W-1': { name: '扶貧單A', price: 350, guarantee: '700萬', cat: '扶貧單' },
  'W-2': { name: '扶貧單B', price: 700, guarantee: '1,500萬', cat: '扶貧單' },
  'W-3': { name: '扶貧單C', price: 199, guarantee: '350萬', cat: '扶貧單' },
  // 戰神錦標賽
  'T-1': { name: '戰神單局清圖', price: 800, guarantee: null, cat: '戰神錦標賽' },
  'T-2': { name: '戰神升星(不吃物資)', price: 50, guarantee: null, cat: '戰神錦標賽' },
  'T-3': { name: '戰神升星10顆星', price: 450, guarantee: null, cat: '戰神錦標賽' },
};

// ── VIP 等級定義 ──
const VIP_TIERS = [
  { min: 200000, name: 'Legend', discount: 0.80, emoji: '👑', color: 0xec4899 },
  { min: 100000, name: 'Diamond', discount: 0.85, emoji: '💎', color: 0x00e5ff },
  { min: 65000, name: 'Gold', discount: 0.90, emoji: '🥇', color: 0xffd700 },
  { min: 30000, name: 'Silver', discount: 0.95, emoji: '🥈', color: 0xc0c0c0 },
  { min: 5000, name: 'Bronze', discount: 0.97, emoji: '🥉', color: 0xcd7f32 },
  { min: 0, name: 'Rookie', discount: 1.0, emoji: '🆕', color: 0x6b7280 },
];

function getVipTier(totalSpent) {
  return VIP_TIERS.find(t => totalSpent >= t.min);
}

// ── 每日優惠池 ──
const DAILY_DEALS = [
  { code: 'E-4', discount: '9折', desc: '護航④ 今日限定 9折！原價2200T → 1980T' },
  { code: 'C-2', discount: '85折', desc: '王牌清圖 限時85折！原價1000T → 850T' },
  { code: 'I-2', discount: '9折', desc: '摸保險50個 今日9折！原價4000T → 3600T' },
  { code: 'S-1', discount: '95折', desc: '機密文件 今日95折！原價4100T → 3895T' },
  { code: 'A-1', discount: '88折', desc: '3x3代肝 超值88折！原價2800T → 2464T' },
  { code: 'P-3', discount: '9折', desc: '陪做套餐 今日9折！原價3688T → 3319T' },
  { code: 'E-5', discount: '95折', desc: '護航⑤ 今日95折！原價3200T → 3040T' },
  { code: 'G-2', discount: '9折', desc: '帶出1500萬 今日9折！原價6888T → 6199T' },
];

// ============================================================
// Discord Client
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ]
});

client.once('ready', async () => {
  console.log(`🌙 MK-01 v3.0 已上線：${client.user.tag}`);
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return console.error('找不到伺服器！');
  await setupChannels(guild);

  if (channels.announcements) {
    const ch = guild.channels.cache.get(channels.announcements);
    if (ch) {
      const embed = new EmbedBuilder()
        .setColor(0x00e5ff)
        .setTitle('🌙 MK-01 v3.0 接單系統已上線')
        .setDescription('自動接單 · 驗證系統 · 排行榜 · 工單 · 每日優惠 · VIP升級公告\n所有功能已就緒！')
        .setTimestamp();
      ch.send({ embeds: [embed] });
    }
  }
});

// ============================================================
// 🔐 驗證系統 — 新成員自動給角色
// ============================================================
client.on('guildMemberAdd', async (member) => {
  try {
    const guild = member.guild;
    const clientRole = guild.roles.cache.find(r => r.name === '客戶');
    if (clientRole) {
      await member.roles.add(clientRole);
      console.log(`✅ 已給 ${member.user.tag} 客戶角色`);
    }

    // 發送歡迎 DM
    try {
      const welcomeEmbed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('🌙 歡迎加入午夜俱樂部！')
        .setDescription(
          `嗨 ${member.user.username}！歡迎來到暗區突圍最強代練俱樂部\n\n` +
          '🎁 **新手推薦：扶貧單 350T 起！**\n' +
          '💰 查看報價：到 `💰｜報價表` 頻道\n' +
          '📝 下單方式：加 LINE **23roger02** 報編號\n\n' +
          '🛡️ 追繳三重賠付 · 純綠玩 · 全程可直播'
        );
      await member.send({ embeds: [welcomeEmbed] });
    } catch (e) { /* DM可能被關閉 */ }

    // 在歡迎頻道公告
    if (channels.welcome) {
      const wCh = guild.channels.cache.get(channels.welcome);
      if (wCh) {
        wCh.send(`🎉 歡迎 <@${member.id}> 加入午夜俱樂部！快到 💰｜報價表 看看服務吧～`);
      }
    }
  } catch (e) { console.error('驗證系統錯誤:', e.message); }
});

// ============================================================
// 💬 指令系統 (訊息觸發)
// ============================================================
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.content.startsWith('!')) return;
  const args = msg.content.slice(1).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  // ── !報到 <打手名> ── 綁定 Discord 帳號到打手名（指定接單用）
  if (cmd === '報到') {
    const name = args.join(' ').trim();
    if (!name) return msg.reply('用法：`!報到 你的打手名`，例如 `!報到 CANDY`');
    const matched = BOOSTER_NAMES.find(v => v.toLowerCase() === name.toLowerCase());
    if (!matched) return msg.reply(`找不到打手名「${name}」。可用：${BOOSTER_NAMES.join('、')}`);
    await dbSaveBoosterReg(matched, msg.author.id);
    return msg.reply(`✅ **${matched}** 報到成功！日後客人指定 ${matched} 的訂單將只有你能接。`);
  }

  // ── !排行榜 / !leaderboard ──
  if (cmd === '排行榜' || cmd === 'leaderboard' || cmd === 'lb') {
    const sorted = [...boosterStats.entries()]
      .sort((a, b) => b[1].completed - a[1].completed)
      .slice(0, 10);

    if (sorted.length === 0) {
      return msg.reply('📊 暫無排行資料，完成訂單後自動更新！');
    }

    const lines = sorted.map(([tag, s], i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
      return `${medal} **${tag}** — ${s.completed} 單 · ${s.revenue.toLocaleString()}T`;
    });

    const embed = new EmbedBuilder()
      .setColor(0xfbbf24)
      .setTitle('🏆 打手排行榜')
      .setDescription(lines.join('\n'))
      .setFooter({ text: '依完成訂單數排名' })
      .setTimestamp();
    msg.channel.send({ embeds: [embed] });
  }

  // ── !報價 / !price ──
  if (cmd === '報價' || cmd === 'price') {
    const code = (args[0] || '').toUpperCase();
    if (code && SERVICES[code]) {
      const s = SERVICES[code];
      const embed = new EmbedBuilder()
        .setColor(0x00e5ff)
        .setTitle(`💰 ${code} ${s.name}`)
        .addFields(
          { name: '價格', value: `${s.price.toLocaleString()} T`, inline: true },
          { name: '保底', value: s.guarantee || '無', inline: true },
          { name: '分類', value: s.cat, inline: true },
        );
      msg.channel.send({ embeds: [embed] });
    } else {
      msg.reply('用法：`!報價 E-4` — 輸入服務編號查詢');
    }
  }

  // ── !vip <contactId> ──
  if (cmd === 'vip') {
    const id = args[0];
    if (!id) return msg.reply('用法：`!vip <你的聯繫ID>`');
    const data = vipData.get(id);
    if (!data) return msg.reply('找不到此 ID 的消費紀錄');
    const tier = getVipTier(data.totalSpent);
    const embed = new EmbedBuilder()
      .setColor(tier.color)
      .setTitle(`${tier.emoji} VIP 會員資訊`)
      .addFields(
        { name: '等級', value: tier.name, inline: true },
        { name: '累計消費', value: `${data.totalSpent.toLocaleString()} T`, inline: true },
        { name: '折扣', value: `${Math.round(tier.discount * 100)}%`, inline: true },
        { name: '訂單數', value: `${data.orders.length}`, inline: true },
      );
    msg.channel.send({ embeds: [embed] });
  }

  // ── !工單 / !ticket <問題描述> ──
  if (cmd === '工單' || cmd === 'ticket') {
    const desc = args.join(' ');
    if (!desc) return msg.reply('用法：`!工單 <問題描述>`');

    const ticketId = `TK${++ticketCounter}`;
    const ticket = {
      id: ticketId,
      userId: msg.author.id,
      userTag: msg.author.tag,
      description: desc,
      status: 'open',
      createdAt: new Date().toISOString(),
      responses: [],
    };
    await dbSaveTicket(ticket);

    const embed = new EmbedBuilder()
      .setColor(0xf43f5e)
      .setTitle(`🎫 工單 #${ticketId}`)
      .addFields(
        { name: '提交者', value: msg.author.tag, inline: true },
        { name: '狀態', value: '🔴 待處理', inline: true },
        { name: '問題描述', value: desc },
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tkresolve_${ticketId}`).setLabel('✅ 已解決').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`tkclose_${ticketId}`).setLabel('❌ 關閉').setStyle(ButtonStyle.Danger),
    );

    // 發到管理頻道
    if (channels.adminLog) {
      const aCh = msg.guild.channels.cache.get(channels.adminLog);
      if (aCh) aCh.send({ embeds: [embed], components: [row] });
    }

    // Telegram 通知
    await sendTelegram(`🎫 新工單 #${ticketId}\n提交者：${msg.author.tag}\n問題：${desc}`);

    msg.reply(`✅ 工單 #${ticketId} 已建立！Roger 會盡快處理。`);
  }

  // ── !同步報價 / !sync ──
  if (cmd === '同步報價' || cmd === 'sync') {
    // 只有 Boss 角色可以操作
    const bossRole = msg.guild.roles.cache.find(r => r.name === 'Boss');
    if (!bossRole || !msg.member.roles.cache.has(bossRole.id)) {
      return msg.reply('❌ 只有 Boss 可以同步報價');
    }
    await syncPricesToDiscord(msg.guild);
    msg.reply('✅ 報價表已同步到 💰｜報價表 頻道！');
  }
});

// ============================================================
// 🎫 工單按鈕處理
// ============================================================
// (merged into main interactionCreate below)

// ============================================================
// 🔔 按鈕互動處理（接單/完成/工單）
// ============================================================
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const [action, id] = interaction.customId.split('_');
  const guild = interaction.guild;

  // ── 工單按鈕 ──
  if (action === 'tkresolve' || action === 'tkclose') {
    const ticket = tickets.get(id);
    if (!ticket) return interaction.reply({ content: '找不到此工單', ephemeral: true });
    ticket.status = action === 'tkresolve' ? 'resolved' : 'closed';
    await dbSaveTicket(ticket);
    const statusText = action === 'tkresolve' ? '✅ 已解決' : '❌ 已關閉';
    await interaction.update({
      embeds: [
        EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(action === 'tkresolve' ? 0x34d399 : 0x6b7280)
          .spliceFields(1, 1, { name: '狀態', value: statusText, inline: true })
      ],
      components: [],
    });
    return;
  }

  // ── 訂單按鈕 ──
  const order = orders.get(id);
  if (!order) return interaction.reply({ content: '❌ 找不到此訂單', ephemeral: true });

  if (action === 'accept') {
    if (order.status !== 'pending') return interaction.reply({ content: '⚠️ 此訂單已被其他打手接走', ephemeral: true });
    if (order.preferredBooster) {
      const wantedId = boosterRegistry.get(order.preferredBooster);
      if (wantedId && interaction.user.id !== wantedId) {
        return interaction.reply({ content: `⚠️ 此單指定由 ${order.preferredBooster} 接單，你無法接此單。`, ephemeral: true });
      }
    }
    order.status = 'active'; order.booster = interaction.user.tag; order.boosterId = interaction.user.id; order.acceptedAt = new Date().toISOString();
    await dbSaveOrder(order);
    await interaction.deferUpdate();
    try { await interaction.message.delete(); } catch(e) {}
    if (channels.activeOrders) {
      const activeCh = guild.channels.cache.get(channels.activeOrders);
      if (activeCh) {
        const activeEmbed = new EmbedBuilder().setColor(0xfbbf24).setTitle(`⚡ 訂單 #${id} — 進行中`)
          .addFields({ name: '🛡️ 服務', value: order.serviceName, inline: true },{ name: '💰 金額', value: `${order.price} T`, inline: true },{ name: '🎮 打手', value: interaction.user.tag, inline: true },{ name: '👤 老闆', value: order.customerName || '未知', inline: true },{ name: '🎯 保底', value: order.guarantee || '無', inline: true },{ name: '🗺️ 地圖', value: order.map || '不指定', inline: true })
          .setFooter({ text: '完成後點下方按鈕' }).setTimestamp();
        const activeRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`done_${id}`).setLabel('✅ 完成訂單').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`problem_${id}`).setLabel('⚠️ 回報問題').setStyle(ButtonStyle.Danger));
        const activeMsg = await activeCh.send({ embeds: [activeEmbed], components: [activeRow] });
        const ref = orderMessages.get(id) || {}; ref.active = { channelId: activeCh.id, messageId: activeMsg.id }; orderMessages.set(id, ref);
      }
    }
    await sendTelegram(`⚡ 訂單 #${id} 已被接單\n打手：${interaction.user.tag}\n服務：${order.serviceName}\n金額：${order.price} T`);
    await interaction.followUp({ content: `✅ 你已接下訂單 #${id}，開始作業吧！`, ephemeral: true });
  }

  if (action === 'done') {
    if (order.boosterId !== interaction.user.id) return interaction.reply({ content: '❌ 只有接單打手可以完成此訂單', ephemeral: true });
    if (order.status !== 'active') return interaction.reply({ content: '⚠️ 訂單狀態不正確', ephemeral: true });
    order.status = 'review'; order.reviewAt = new Date().toISOString();
    await dbSaveOrder(order);
    try { await interaction.message.delete(); } catch(e) {}
    const dRef = orderMessages.get(id);
    if (dRef && dRef.newOrder) { try { const nCh = guild.channels.cache.get(dRef.newOrder.channelId); if (nCh) { const m = await nCh.messages.fetch(dRef.newOrder.messageId); await m.delete(); } } catch(e) {} }
    if (channels.completed) {
      const cCh = guild.channels.cache.get(channels.completed);
      if (cCh) {
        const rEmbed = new EmbedBuilder().setColor(0xfbbf24).setTitle(`⏳ 訂單 #${id} 待核准入帳`).setDescription('打手回報完成，**待老闆核准後才會計入報表/營收**。').addFields({ name: '服務', value: order.serviceName, inline: true },{ name: '金額', value: `${order.price} T`, inline: true },{ name: '打手', value: order.booster, inline: true },{ name: '聯繫', value: order.contactId || '未填', inline: true }).setTimestamp();
        const rRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`approve_${id}`).setLabel('✅ 核准入帳').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`reject_${id}`).setLabel('❌ 退回').setStyle(ButtonStyle.Danger));
        await cCh.send({ embeds: [rEmbed], components: [rRow] });
      }
    }
    return interaction.reply({ content: `✅ 已回報完成，訂單 #${id} 待老闆核准入帳。`, ephemeral: true });
  }

  if (action === 'reject') {
    const isBoss = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || (interaction.member && interaction.member.roles.cache.some(r => r.name === 'Boss'));
    if (!isBoss) return interaction.reply({ content: '⚠️ 只有老闆/管理員可以審核訂單。', ephemeral: true });
    order.status = 'cancelled'; await dbSaveOrder(order);
    return interaction.update({ content: `❌ 訂單 #${id} 已退回（不計入報表）。`, embeds: [], components: [] });
  }

  if (action === 'approve') {
    const isBoss = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || (interaction.member && interaction.member.roles.cache.some(r => r.name === 'Boss'));
    if (!isBoss) return interaction.reply({ content: '⚠️ 只有老闆/管理員可以核准入帳。', ephemeral: true });
    if (order.status !== 'review') return interaction.reply({ content: '⚠️ 此訂單不在待審核狀態。', ephemeral: true });
    await interaction.deferUpdate().catch(()=>{});
    order.status = 'completed'; order.completedAt = new Date().toISOString();
    await dbSaveOrder(order);
    dailyStats.revenue += order.price; dailyStats.count += 1; dailyStats.services[order.serviceCode] = (dailyStats.services[order.serviceCode] || 0) + 1;
    try { await interaction.message.delete(); } catch(e) {}
    const msgRef = orderMessages.get(id);
    if (msgRef && msgRef.newOrder) { try { const nCh = guild.channels.cache.get(msgRef.newOrder.channelId); if (nCh) { const m = await nCh.messages.fetch(msgRef.newOrder.messageId); await m.delete(); } } catch(e) {} }

    // ── 更新打手排行榜 ──
    const bs = boosterStats.get(order.booster) || { completed: 0, revenue: 0, name: order.booster };
    bs.completed += 1;
    bs.revenue += order.price;
    await dbSaveBooster(order.booster, bs);

    // ── 更新 VIP 資料 ──
    if (order.contactId && order.contactId !== '未填') {
      const vip = vipData.get(order.contactId) || { contactId: order.contactId, totalSpent: 0, orders: [], name: order.customerName };
      const oldTier = getVipTier(vip.totalSpent);
      vip.totalSpent += order.price;
      vip.orders.push({ id, service: order.serviceName, price: order.price, date: order.completedAt });
      await dbSaveVip(order.contactId, vip);

      // ── VIP 升級公告 ──
      const newTier = getVipTier(vip.totalSpent);
      if (newTier.min > oldTier.min) {
        await announceVipUpgrade(guild, order.customerName || order.contactId, newTier, vip.totalSpent);
      }
    }

    // ── 推薦追蹤（訂單完成時觸發） ──
    if (order.referralCode) {
      const refData = referrals.get(order.referralCode);
      if (refData) {
        const alreadyReferred = refData.referred.find(r => r.contactId === order.contactId);
        if (!alreadyReferred) {
          refData.referred.push({ contactId: order.contactId, name: order.customerName, date: order.completedAt, orderAmount: order.price });
          refData.totalReferred = refData.referred.length;

          // 推薦人獲得 5% 折抵券
          const couponAmount = Math.round(order.price * 0.05);
          refData.coupons.push({ amount: couponAmount, reason: `推薦 ${order.customerName} 首單返還`, date: order.completedAt, used: false });

          // 檢查里程碑
          const oldMilestone = refData.milestone;
          const newMilestone = checkMilestone(refData);
          if (newMilestone && (!oldMilestone || newMilestone.count > oldMilestone.count)) {
            refData.milestone = newMilestone;
            if (newMilestone.permDiscount) refData.permDiscount = newMilestone.permDiscount;
            if (newMilestone.vipBonus && refData.ownerId) {
              const vip = vipData.get(refData.ownerId) || { totalSpent: 0, orders: [], name: refData.ownerName };
              vip.totalSpent += newMilestone.vipBonus;
              vipData.set(refData.ownerId, vip);
            }

            // Discord + Telegram 里程碑公告
            if (channels.announcements) {
              const annCh = guild.channels.cache.get(channels.announcements);
              if (annCh) {
                const mEmbed = new EmbedBuilder().setColor(0xec4899).setTitle(`🤝 推薦里程碑達成！`)
                  .setDescription(`🎉 **${refData.ownerName}** 達成 **${newMilestone.name}**！\n\n累計推薦：${refData.totalReferred} 人\n獎勵：${newMilestone.reward}\n\n推薦碼：\`${refData.code}\`\n使用推薦碼下單，雙方都有獎勵！🌙`)
                  .setTimestamp();
                annCh.send({ embeds: [mEmbed] });
              }
            }
            await sendTelegram(`🤝 推薦里程碑！\n${refData.ownerName} 達成 ${newMilestone.name}\n累計推薦：${refData.totalReferred} 人\n獎勵：${newMilestone.reward}`);
          }

          // 10 人以上每多推 1 人 +150T
          if (refData.totalReferred > 10) {
            refData.coupons.push({ amount: 150, reason: `超級推薦人額外獎勵（第${refData.totalReferred}人）`, date: order.completedAt, used: false });
          }

          await dbSaveReferral(order.referralCode, refData);
        }
      }
    }

    if (channels.completed) {
      const compCh = guild.channels.cache.get(channels.completed);
      if (compCh) {
        const compEmbed = new EmbedBuilder().setColor(0x34d399).setTitle(`✅ 訂單 #${id} 完成`)
          .addFields({ name: '服務', value: order.serviceName, inline: true },{ name: '金額', value: `${order.price} T`, inline: true },{ name: '打手', value: order.booster, inline: true },{ name: '耗時', value: getTimeDiff(order.acceptedAt, order.completedAt), inline: true }).setTimestamp();
        compCh.send({ embeds: [compEmbed] });
      }
    }
    await logCustomerOrder(guild, order);
    await sendTelegram(`✅ 訂單 #${id} 已完成\n服務：${order.serviceName}\n金額：${order.price} T\n打手：${order.booster}\n耗時：${getTimeDiff(order.acceptedAt, order.completedAt)}`);
  }

  if (action === 'problem') {
    await interaction.reply({ content: `⚠️ 訂單 #${id} 問題已通知 Roger`, ephemeral: true });
    await sendTelegram(`⚠️ 訂單 #${id} 有問題！\n打手：${interaction.user.tag}\n服務：${order.serviceName}\n請盡快處理！`);
  }
});

// ============================================================
// 👑 VIP 升級公告
// ============================================================
async function announceVipUpgrade(guild, customerName, tier, totalSpent) {
  if (!channels.announcements) return;
  const ch = guild.channels.cache.get(channels.announcements);
  if (!ch) return;

  const embed = new EmbedBuilder()
    .setColor(tier.color)
    .setTitle(`${tier.emoji} VIP 升級公告！`)
    .setDescription(
      `🎉 恭喜 **${customerName}** 升級為 **${tier.name}** 會員！\n\n` +
      `累計消費：${totalSpent.toLocaleString()} T\n` +
      `享有折扣：${Math.round(tier.discount * 100)}%\n\n` +
      `感謝老闆的支持！🌙`
    )
    .setTimestamp();
  ch.send({ embeds: [embed] });

  await sendTelegram(`👑 VIP升級！\n客戶：${customerName}\n新等級：${tier.name} ${tier.emoji}\n累計：${totalSpent.toLocaleString()}T`);
}

// ============================================================
// 📢 8591 報價同步到 Discord
// ============================================================
async function syncPricesToDiscord(guild) {
  if (!channels.priceList) return;
  const pCh = guild.channels.cache.get(channels.priceList);
  if (!pCh) return;

  // 清除舊訊息
  try {
    const oldMsgs = await pCh.messages.fetch({ limit: 20 });
    if (oldMsgs.size > 0) await pCh.bulkDelete(oldMsgs).catch(() => {});
  } catch(e) {}

  const e1 = new EmbedBuilder().setColor(0x00e5ff).setTitle('🛡️ 護航單（包鑰匙·不卡保底·無封頂·追繳三重賠付）')
    .setDescription(Object.entries(SERVICES).filter(([,s]) => s.cat === '護航').map(([k,s]) => `**${k}** ${s.name} — **${s.price.toLocaleString()}T** ${s.guarantee ? `→ 保底 ${s.guarantee}` : ''}`).join('\n') + '\n\n🎁 單局撤離(R系列)買五送一！');
  const e2 = new EmbedBuilder().setColor(0xfbbf24).setTitle('🧹 清圖 · 🎲 摸保險 · 💰 對賭')
    .setDescription(
      '**清圖：**\n' + Object.entries(SERVICES).filter(([,s]) => s.cat === '清圖').map(([k,s]) => `${k} ${s.name} — **${s.price.toLocaleString()}T**/局`).join('\n') +
      '\n\n**摸保險：**\n' + Object.entries(SERVICES).filter(([,s]) => s.cat === '摸保險').map(([k,s]) => `${k} ${s.name} — **${s.price.toLocaleString()}T** ${s.guarantee ? `→ 保底 ${s.guarantee}` : ''}`).join('\n') +
      '\n\n**對賭：**\n' + Object.entries(SERVICES).filter(([,s]) => s.cat === '對賭').map(([k,s]) => `${k} ${s.name} — **${s.price.toLocaleString()}T** ${s.guarantee ? `→ 保底 ${s.guarantee}` : ''}`).join('\n')
    );
  const e3 = new EmbedBuilder().setColor(0xec4899).setTitle('🗺️ 特殊地圖 · 🧬 代肝 · 🎮 陪玩')
    .setDescription(
      '**特殊地圖：**\n' + Object.entries(SERVICES).filter(([,s]) => s.cat === '特殊地圖').map(([k,s]) => `${k} ${s.name} — **${s.price.toLocaleString()}T** ${s.guarantee ? `→ 保底 ${s.guarantee}` : ''}`).join('\n') +
      '\n\n**代肝：**\n' + Object.entries(SERVICES).filter(([,s]) => s.cat === '代肝').map(([k,s]) => `${k} ${s.name} — **${s.price.toLocaleString()}T**`).join('\n') +
      '\n\n**陪玩：**\n' + Object.entries(SERVICES).filter(([,s]) => s.cat === '陪玩').map(([k,s]) => `${k} ${s.name} — **${s.price.toLocaleString()}T**`).join('\n')
    );
  const e4 = new EmbedBuilder().setColor(0x34d399).setTitle('🎁 扶貧單 + 📋 下單方式')
    .setDescription('**扶貧單（每週限一次）：**\nA方案 **350T** → 保底 700萬\nB方案 **700T** → 保底 1,500萬\n\n━━━━━━━━━━━━━━\n**報編號就能下單！**\n加 LINE：**23roger02**\n🔥 追繳三重賠付：全額退 + 1000T + 2625點卷');

  await pCh.send({ embeds: [e1, e2, e3, e4] });
  console.log('✅ 報價表已同步到 Discord');
}

// ============================================================
// 自動建立頻道與角色（v3.1 六區架構）
// ============================================================
// 📋 資訊公告（唯讀）  — 歡迎、公告、報價表、好評曬單
// 💬 暗區社群（公開）  — 閒聊、攻略、戰績、組隊
// 🎮 客戶專區（客戶+） — 老闆大廳、訂單查詢、VIP包廂
// 🛡️ 接單系統（打手+Boss）— 新訂單、進行中、已完成
// 🔒 內部管理（打手+Boss）— 打手聊天、報表、管理日誌
// 🔊 語音頻道 — 公開 / 客戶限定 / 代練作業 / VIP
// ============================================================
async function setupChannels(guild) {
  // ── 建立角色 ──
  const roleDefs = [
    { name: 'Boss', color: 0xf43f5e, hoist: true },
    { name: 'Booster', color: 0xfbbf24, hoist: true },
    { name: 'VIP客戶', color: 0x8b5cf6, hoist: true },
    { name: '客戶', color: 0x6b7280, hoist: false },
  ];
  for (const rd of roleDefs) {
    if (!guild.roles.cache.find(r => r.name === rd.name)) {
      await guild.roles.create({ name: rd.name, color: rd.color, hoist: rd.hoist, reason: 'MK-01' });
      console.log(`✅ 已建立角色：${rd.name}`);
    }
  }

  // ── 取得角色參考 ──
  const bossRole = guild.roles.cache.find(r => r.name === 'Boss');
  const boosterRole = guild.roles.cache.find(r => r.name === 'Booster');
  const vipRole = guild.roles.cache.find(r => r.name === 'VIP客戶');
  const clientRole = guild.roles.cache.find(r => r.name === '客戶');

  // ── 常用權限組合 ──
  const permStaffOnly = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(boosterRole ? [{ id: boosterRole.id, allow: [PermissionFlagsBits.ViewChannel] }] : []),
    ...(bossRole ? [{ id: bossRole.id, allow: [PermissionFlagsBits.ViewChannel] }] : []),
  ];
  const permClientUp = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(clientRole ? [{ id: clientRole.id, allow: [PermissionFlagsBits.ViewChannel] }] : []),
    ...(vipRole ? [{ id: vipRole.id, allow: [PermissionFlagsBits.ViewChannel] }] : []),
    ...(boosterRole ? [{ id: boosterRole.id, allow: [PermissionFlagsBits.ViewChannel] }] : []),
    ...(bossRole ? [{ id: bossRole.id, allow: [PermissionFlagsBits.ViewChannel] }] : []),
  ];
  const permVipUp = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(vipRole ? [{ id: vipRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
    ...(boosterRole ? [{ id: boosterRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
    ...(bossRole ? [{ id: bossRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
  ];
  const permClientVoice = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(clientRole ? [{ id: clientRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
    ...(vipRole ? [{ id: vipRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
    ...(boosterRole ? [{ id: boosterRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
    ...(bossRole ? [{ id: bossRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
  ];
  const permStaffVoice = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(boosterRole ? [{ id: boosterRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
    ...(bossRole ? [{ id: bossRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }] : []),
  ];

  // ── 六大分類 ──
  const categoryDefs = [
    {
      key: 'catInfo', name: '📋 資訊公告',
      perms: [
        { id: guild.id, deny: [PermissionFlagsBits.SendMessages] },
        ...(bossRole ? [{ id: bossRole.id, allow: [PermissionFlagsBits.SendMessages] }] : []),
        ...(boosterRole ? [{ id: boosterRole.id, allow: [PermissionFlagsBits.SendMessages] }] : []),
      ]
    },
    { key: 'catCommunity', name: '💬 暗區社群' },
    { key: 'catCustomer', name: '🎮 客戶專區', perms: permClientUp },
    { key: 'catOrders', name: '🛡️ 接單系統', perms: permStaffOnly },
    { key: 'catInternal', name: '🔒 內部管理', perms: permStaffOnly },
    { key: 'catVoice', name: '🔊 語音頻道' },
  ];

  // ── 頻道定義 ──
  const channelDefs = [
    // ─── 📋 資訊公告（唯讀，僅 Boss/Booster 可發言） ───
    { key: 'welcome', name: '👋｜歡迎光臨', cat: 'catInfo' },
    { key: 'announcements', name: '📢｜公告', cat: 'catInfo' },
    { key: 'priceList', name: '💰｜報價表', cat: 'catInfo' },
    { key: 'reviews', name: '⭐｜好評曬單', cat: 'catInfo' },

    // ─── 💬 暗區社群（公開互動） ───
    { key: 'chat', name: '💬｜閒聊吹水', cat: 'catCommunity' },
    { key: 'gameChat', name: '🔫｜暗區攻略', cat: 'catCommunity' },
    { key: 'showoff', name: '🏆｜戰績曬單', cat: 'catCommunity' },
    { key: 'lfg', name: '🎯｜組隊找人', cat: 'catCommunity' },

    // ─── 🎮 客戶專區（需客戶角色以上） ───
    { key: 'customerLobby', name: '🎮｜老闆大廳', cat: 'catCustomer' },
    { key: 'customerOrders', name: '📋｜訂單查詢', cat: 'catCustomer' },
    { key: 'vipLounge', name: '👑｜VIP包廂', cat: 'catCustomer', perms: permVipUp },

    // ─── 🛡️ 接單系統（僅打手 + Boss 可見） ───
    { key: 'newOrders', name: '🔔｜新訂單', cat: 'catOrders' },
    { key: 'activeOrders', name: '⚡｜進行中', cat: 'catOrders' },
    { key: 'completed', name: '✅｜已完成', cat: 'catOrders' },

    // ─── 🔒 內部管理（僅打手 + Boss 可見） ───
    { key: 'boosterChat', name: '💬｜打手聊天', cat: 'catInternal' },
    { key: 'dailyStats', name: '📊｜每日報表', cat: 'catInternal' },
    { key: 'adminLog', name: '📋｜管理日誌', cat: 'catInternal' },
    { key: 'custLedger', name: '📒｜客戶訂單紀錄', cat: 'catInternal' },

    // ─── 🔊 語音頻道（分層權限） ───
    // 公開 — 所有人可進
    { key: 'vcLobby', name: '🔊｜大廳聊天', cat: 'catVoice', voice: true },
    { key: 'vcTeam1', name: '🎯｜組隊 1', cat: 'catVoice', voice: true, userLimit: 5 },
    { key: 'vcTeam2', name: '🎯｜組隊 2', cat: 'catVoice', voice: true, userLimit: 5 },
    // 客戶限定 — 需客戶角色
    { key: 'vcBoss1', name: '🎮｜老闆開黑 1', cat: 'catVoice', voice: true, userLimit: 5, perms: permClientVoice },
    { key: 'vcBoss2', name: '🎮｜老闆開黑 2', cat: 'catVoice', voice: true, userLimit: 5, perms: permClientVoice },
    // 代練作業 — 僅打手 + Boss
    { key: 'vcBoost1', name: '🛡️｜代練作業 1', cat: 'catVoice', voice: true, userLimit: 5, perms: permStaffVoice },
    { key: 'vcBoost2', name: '🛡️｜代練作業 2', cat: 'catVoice', voice: true, userLimit: 5, perms: permStaffVoice },
    // VIP — 僅 VIP + 打手 + Boss
    { key: 'vcVip1', name: '👑｜VIP 包廂 1', cat: 'catVoice', voice: true, perms: permVipUp },
    { key: 'vcVip2', name: '👑｜VIP 包廂 2', cat: 'catVoice', voice: true, perms: permVipUp },
  ];

  // ── 建立 / 更新分類 ──
  const categories = {};
  for (const catDef of categoryDefs) {
    let cat = guild.channels.cache.find(c => c.name === catDef.name && c.type === ChannelType.GuildCategory);
    if (!cat) {
      cat = await guild.channels.create({
        name: catDef.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: catDef.perms || undefined,
        reason: 'MK-01 v3.1 頻道重組'
      });
      console.log(`✅ 已建立分類：${catDef.name}`);
    } else if (catDef.perms) {
      // 既有分類 → 同步權限
      await cat.permissionOverwrites.set(catDef.perms, 'MK-01 v3.1 權限同步').catch(() => {});
    }
    categories[catDef.key] = cat.id;
  }

  // ── 建立 / 更新頻道 ──
  for (const cd of channelDefs) {
    const parentId = categories[cd.cat];
    const chType = cd.voice ? ChannelType.GuildVoice : ChannelType.GuildText;
    let ch = guild.channels.cache.find(c => c.name === cd.name && c.parentId === parentId)
          || guild.channels.cache.find(c => c.name === cd.name);

    if (!ch) {
      const opts = {
        name: cd.name,
        type: chType,
        parent: parentId,
        permissionOverwrites: cd.perms || undefined,
        reason: 'MK-01 v3.1 頻道重組'
      };
      if (cd.voice && cd.userLimit) opts.userLimit = cd.userLimit;
      ch = await guild.channels.create(opts);
      console.log(`✅ 已建立${cd.voice ? '語音' : '文字'}頻道：${cd.name}`);
    } else {
      // 既有頻道 → 同步歸屬與權限
      if (ch.parentId !== parentId) {
        await ch.setParent(parentId, { lockPermissions: false, reason: 'MK-01 v3.1 歸類調整' }).catch(() => {});
      }
      if (cd.perms) {
        await ch.permissionOverwrites.set(cd.perms, 'MK-01 v3.1 權限同步').catch(() => {});
      }
    }
    channels[cd.key] = ch.id;
  }

  console.log('🌙 頻道設定完成（v3.1 六區架構 · 分層權限）');
}

// ============================================================
// Telegram
// ============================================================
async function sendTelegram(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: `🌙 午夜俱樂部\n━━━━━━━━━━\n${text}` })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram 錯誤:', JSON.stringify(data));
  } catch (e) { console.error('Telegram 失敗:', e.message); }
}

// ============================================================
// 📱 LINE Messaging API
// ============================================================
async function sendLineNotify(userId, messages) {
  if (!lineClient || !userId) return;
  try {
    await lineClient.pushMessage({ to: userId, messages: Array.isArray(messages) ? messages : [messages] });
  } catch (e) { console.error('LINE 推播失敗:', e.message); }
}

async function sendLineOrderNotify(order) {
  if (!lineClient || !LINE_ADMIN_ID) return;
  const qtyText = order.quantity > 1
    ? `${order.quantity} 單${order.freeQuantity > 0 ? `（付${order.paidQuantity}+送${order.freeQuantity}）` : ''}`
    : '1 單';
  const vipText = order.vipTier ? `👑 VIP ${order.vipTier}` : '';
  const flexMsg = {
    type: 'flex', altText: `🔔 新訂單 #${order.id} — ${order.serviceName}`,
    contents: {
      type: 'bubble',
      styles: { header: { backgroundColor: '#0a0e1a' }, body: { backgroundColor: '#111827' }, footer: { backgroundColor: '#111827' } },
      header: { type: 'box', layout: 'vertical', contents: [
        { type: 'text', text: `🔔 新訂單 #${order.id}`, color: '#00e5ff', size: 'lg', weight: 'bold' },
        { type: 'text', text: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }), color: '#94a3b8', size: 'xs' }
      ]},
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '服務', color: '#94a3b8', size: 'sm', flex: 2 },
          { type: 'text', text: order.serviceName, color: '#ffffff', size: 'sm', flex: 5, align: 'end' }
        ]},
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '金額', color: '#94a3b8', size: 'sm', flex: 2 },
          { type: 'text', text: `${order.price.toLocaleString()} T`, color: '#00e5ff', size: 'sm', weight: 'bold', flex: 5, align: 'end' }
        ]},
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '數量', color: '#94a3b8', size: 'sm', flex: 2 },
          { type: 'text', text: qtyText, color: '#ffffff', size: 'sm', flex: 5, align: 'end' }
        ]},
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '遊戲ID', color: '#94a3b8', size: 'sm', flex: 2 },
          { type: 'text', text: order.gameId, color: '#ffffff', size: 'sm', flex: 5, align: 'end' }
        ]},
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: '聯繫', color: '#94a3b8', size: 'sm', flex: 2 },
          { type: 'text', text: order.contactId, color: '#ffffff', size: 'sm', flex: 5, align: 'end' }
        ]},
        ...(vipText ? [{ type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: 'VIP', color: '#94a3b8', size: 'sm', flex: 2 },
          { type: 'text', text: vipText, color: '#fbbf24', size: 'sm', flex: 5, align: 'end' }
        ]}] : []),
      ]},
      footer: { type: 'box', layout: 'vertical', contents: [
        { type: 'button', action: { type: 'uri', label: '查看訂單', uri: 'https://bucolic-pie-025fe2.netlify.app/#order' }, style: 'primary', color: '#00e5ff' }
      ]}
    }
  };
  await sendLineNotify(LINE_ADMIN_ID, flexMsg);
}

// LINE Webhook — 自動回覆
async function handleLineEvent(event) {
  if (event.type !== 'message') return;

  // ── 轉發客人訊息到管理員私人 LINE（文字/圖片/貼圖都通知）──
  const senderId = event.source && event.source.userId;
  if (senderId && LINE_ADMIN_ID && senderId !== LINE_ADMIN_ID && lineClient) {
    let senderName = '客人';
    try { const prof = await lineClient.getProfile(senderId); senderName = prof.displayName || senderName; } catch (e) {}
    let preview;
    if (event.message.type === 'text') preview = event.message.text;
    else if (event.message.type === 'image') preview = '[圖片]';
    else if (event.message.type === 'sticker') preview = '[貼圖]';
    else preview = `[${event.message.type}]`;
    await sendLineNotify(LINE_ADMIN_ID, { type: 'text', text: `📨 LINE 新訊息\n👤 ${senderName}\n💬 ${preview}\n\n（在官方帳號 App 直接回覆）` }).catch(() => {});
  }

  if (event.message.type !== 'text') return;
  const text = event.message.text.trim();
  let reply = null;
  const SITE = 'https://midnight-club.roger96141.workers.dev';

  if (/報價|價格|多少錢|費用/.test(text)) {
    reply = { type: 'text', text: `📋 午夜俱樂部 報價表\n\n🛡️ 護航：400T~3,500T\n🧹 清圖：300T~2,400T\n🏦 搬保險：250T~450T\n💰 搬金：550T\n\n👑 VIP最高92折 | 🎁 買五送一\n\n🔗 完整報價：${SITE}/#pricing` };
  } else if (/下單|我要下單|怎麼下單/.test(text)) {
    reply = { type: 'text', text: `⚡ 下單超簡單！\n\n1️⃣ 點下方選單「立即下單」\n2️⃣ 選服務 → 填資料 → 送出\n3️⃣ 我們立即安排打手\n\n🔗 ${SITE}/#order` };
  } else if (/VIP|折扣|等級|優惠/.test(text)) {
    reply = { type: 'text', text: `👑 VIP 制度\n\n🥉 銅牌 5,000T → 98折\n🥈 銀牌 15,000T → 97折\n🥇 金牌 40,000T → 95折\n💎 鑽石 100,000T → 93折\n🏆 傳說 200,000T → 92折\n\n🔗 查詢：${SITE}/#myvip` };
  } else if (/打手|代練|介紹/.test(text)) {
    reply = { type: 'text', text: `🎮 打手陣容\n\n✅ 自家培訓不外聘\n✅ 全程可直播\n✅ 追繳三重賠付\n📊 3,000+單 | ⭐ 99%滿意度\n\n🔗 ${SITE}/#players` };
  } else if (/進度|我的單|查詢訂單/.test(text)) {
    reply = { type: 'text', text: `📦 查詢訂單進度\n\n請提供：\n1. 你的遊戲 ID\n2. LINE/Discord ID\n\n我們會盡快回覆！\n🔗 ${SITE}/#myvip` };
  }

  if (reply && lineClient) {
    try {
      await lineClient.replyMessage({ replyToken: event.replyToken, messages: [reply] });
    } catch (e) { console.error('LINE 回覆失敗:', e.message); }
  }
}

// ============================================================
// ⏰ 排程任務
// ============================================================

// ── 每日優惠（每天 10:00） ──
cron.schedule('0 10 * * *', async () => {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild || !channels.announcements) return;
  const ch = guild.channels.cache.get(channels.announcements);
  if (!ch) return;

  const deal = DAILY_DEALS[Math.floor(Math.random() * DAILY_DEALS.length)];
  const svc = SERVICES[deal.code];

  const embed = new EmbedBuilder()
    .setColor(0xf43f5e)
    .setTitle('🔥 今日限時優惠！')
    .setDescription(
      `**${deal.desc}**\n\n` +
      `服務：${deal.code} ${svc.name}\n` +
      `優惠：**${deal.discount}**\n\n` +
      `⏰ 僅限今日！加 LINE **23roger02** 報編號 + 說「今日優惠」\n` +
      `🛡️ 追繳三重賠付照樣適用`
    )
    .setFooter({ text: '午夜俱樂部 · 每日一檔限時優惠' })
    .setTimestamp();
  ch.send({ content: '@everyone 🔥 今日優惠來啦！', embeds: [embed] });

  await sendTelegram(`🔥 今日優惠已發送\n${deal.desc}`);
}, { timezone: 'Asia/Taipei' });

// ── 每日報表（每晚 23:00）── 完整版 ──
cron.schedule('0 23 * * *', async () => {
  const now = new Date();
  const today = now.toLocaleDateString('zh-TW');
  const todayISO = now.toISOString().slice(0, 10);

  const allOrders = [...orders.values()];
  const completedToday = allOrders.filter(o => o.status === 'completed' && o.completedAt && o.completedAt.startsWith(todayISO));
  const pendingCount = allOrders.filter(o => o.status === 'pending').length;
  const activeCount = allOrders.filter(o => o.status === 'active').length;
  const totalRevenue = completedToday.reduce((sum, o) => sum + o.price, 0);

  // 服務分類統計
  const serviceBreakdown = {};
  completedToday.forEach(o => { serviceBreakdown[o.serviceName] = (serviceBreakdown[o.serviceName] || 0) + 1; });
  const breakdownStr = Object.entries(serviceBreakdown).map(([k, v]) => `  ${k}: ${v} 單`).join('\n') || '  （無）';

  // 每筆訂單明細
  const orderDetails = completedToday.map(o => {
    const duration = getTimeDiff(o.acceptedAt, o.completedAt);
    return `  #${o.id} | ${o.serviceName} | ${o.price}T | ${o.booster || '未知'} | ${duration}`;
  }).join('\n') || '  （今日無完成訂單）';

  // 打手績效
  const boosterToday = {};
  completedToday.forEach(o => {
    if (!o.booster) return;
    const b = boosterToday[o.booster] || { count: 0, revenue: 0 };
    b.count++; b.revenue += o.price;
    boosterToday[o.booster] = b;
  });
  const boosterStr = Object.entries(boosterToday)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([name, s]) => `  ${name}: ${s.count}單 / ${s.revenue.toLocaleString()}T`)
    .join('\n') || '  （無）';

  // VIP 客戶統計
  const vipCount = [...vipData.values()].filter(v => getVipTier(v.totalSpent).name !== 'Rookie').length;
  const openTickets = [...tickets.values()].filter(t => t.status === 'open').length;

  // 月累計
  const monthStart = todayISO.slice(0, 7); // YYYY-MM
  const monthOrders = allOrders.filter(o => o.status === 'completed' && o.completedAt && o.completedAt.startsWith(monthStart));
  const monthRevenue = monthOrders.reduce((s, o) => s + o.price, 0);

  const report =
    `📊 每日營運報表 — ${today}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `📈 今日總覽\n` +
    `  ✅ 完成：${completedToday.length} 單\n` +
    `  💰 營收：${totalRevenue.toLocaleString()} T\n` +
    `  ⚡ 進行中：${activeCount} 單\n` +
    `  🔔 待接單：${pendingCount} 單\n` +
    `  🎫 待處理工單：${openTickets}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📋 訂單明細（編號｜服務｜金額｜打手｜耗時）\n${orderDetails}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📊 服務統計\n${breakdownStr}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🎮 打手績效\n${boosterStr}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📅 本月累計\n` +
    `  訂單：${monthOrders.length} 單\n` +
    `  營收：${monthRevenue.toLocaleString()} T\n` +
    `  VIP會員：${vipCount} 人\n` +
    `  總累計訂單：${allOrders.length} 單`;

  await sendTelegram(report);

  // Discord 報表
  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild && channels.dailyStats) {
    const statsCh = guild.channels.cache.get(channels.dailyStats);
    if (statsCh) {
      const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle(`📊 每日報表 — ${today}`)
        .addFields(
          { name: '✅ 完成', value: `${completedToday.length} 單`, inline: true },
          { name: '💰 營收', value: `${totalRevenue.toLocaleString()} T`, inline: true },
          { name: '⚡ 進行中', value: `${activeCount} 單`, inline: true },
          { name: '🔔 待接', value: `${pendingCount} 單`, inline: true },
          { name: '📋 服務統計', value: breakdownStr },
          { name: '🎮 打手績效', value: boosterStr },
          { name: '📅 本月累計', value: `${monthOrders.length} 單 / ${monthRevenue.toLocaleString()} T` },
        ).setTimestamp();
      statsCh.send({ embeds: [embed] });
    }
  }
  dailyStats.revenue = 0; dailyStats.count = 0; dailyStats.services = {};
}, { timezone: 'Asia/Taipei' });

// ── 月度財務報表（每月1號 09:00） ──
const MONTHLY_COST = 3500; // 網站維護月費
const COMMISSION_RATE = 0.05; // 抽成比例 5%

cron.schedule('0 9 1 * *', async () => {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthLabel = `${lastMonth.getFullYear()}/${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
  const monthPrefix = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

  const allOrders = [...orders.values()];
  const monthOrders = allOrders.filter(o => o.status === 'completed' && o.completedAt && o.completedAt.startsWith(monthPrefix));
  const totalRevenue = monthOrders.reduce((s, o) => s + o.price, 0);
  const commission = Math.round(totalRevenue * COMMISSION_RATE);
  const profit = commission - MONTHLY_COST;

  // 服務類別營收
  const catRevenue = {};
  monthOrders.forEach(o => {
    const svc = SERVICES[o.serviceCode];
    const cat = svc ? svc.cat : '其他';
    catRevenue[cat] = (catRevenue[cat] || 0) + o.price;
  });
  const catStr = Object.entries(catRevenue)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, rev]) => `  ${cat}: ${rev.toLocaleString()}T (${Math.round(rev/totalRevenue*100)}%)`)
    .join('\n') || '  （無）';

  // 打手月排行
  const boosterMonth = {};
  monthOrders.forEach(o => {
    if (!o.booster) return;
    const b = boosterMonth[o.booster] || { count: 0, revenue: 0 };
    b.count++; b.revenue += o.price;
    boosterMonth[o.booster] = b;
  });
  const boosterRank = Object.entries(boosterMonth)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([name, s], i) => `  ${i+1}. ${name}: ${s.count}單 / ${s.revenue.toLocaleString()}T`)
    .join('\n') || '  （無）';

  // 平均客單價
  const avgPrice = monthOrders.length > 0 ? Math.round(totalRevenue / monthOrders.length) : 0;

  // VIP 統計
  const vipBreakdown = {};
  [...vipData.values()].forEach(v => {
    const tier = getVipTier(v.totalSpent).name;
    vipBreakdown[tier] = (vipBreakdown[tier] || 0) + 1;
  });
  const vipStr = Object.entries(vipBreakdown)
    .filter(([k]) => k !== 'Rookie')
    .map(([k, v]) => `  ${k}: ${v}人`)
    .join('\n') || '  （無VIP會員）';

  const report =
    `💰 月度財務報表 — ${monthLabel}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `📈 營收總覽\n` +
    `  總營收：${totalRevenue.toLocaleString()} T\n` +
    `  總訂單：${monthOrders.length} 單\n` +
    `  平均客單價：${avgPrice.toLocaleString()} T\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💵 財務計算\n` +
    `  抽成比例：${(COMMISSION_RATE * 100)}%\n` +
    `  抽成收入：${commission.toLocaleString()} T\n` +
    `  網站維護費：-${MONTHLY_COST.toLocaleString()} T\n` +
    `  ────────────\n` +
    `  淨利潤：${profit >= 0 ? '+' : ''}${profit.toLocaleString()} T ${profit >= 0 ? '✅' : '⚠️'}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📊 營收分類\n${catStr}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🏆 打手月排行\n${boosterRank}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👑 VIP 會員分布\n${vipStr}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📌 損益平衡點：月營收 ≥ ${Math.ceil(MONTHLY_COST / COMMISSION_RATE).toLocaleString()} T\n` +
    `   即每月 ≥ ${Math.ceil(MONTHLY_COST / COMMISSION_RATE / avgPrice || 18)} 單（以平均客單價計算）`;

  await sendTelegram(report);
}, { timezone: 'Asia/Taipei' });


// ============================================================
// Express API
// ============================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://midnight-club.roger96141.workers.dev');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── LINE Webhook ──
app.post('/webhook/line', (req, res) => {
  res.status(200).end();
  if (req.body && req.body.events) {
    for (const event of req.body.events) { handleLineEvent(event); }
  }
});

app.get('/', (req, res) => {
  res.json({ status: '🌙 MK-01 v3.0 Online', orders: orders.size, uptime: process.uptime(), vipMembers: vipData.size, openTickets: [...tickets.values()].filter(t => t.status === 'open').length });
});

// ── 簡易防灌單流量限制（每 IP 每分鐘最多 5 筆）──
const orderRateLimit = new Map();
function checkOrderRate(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxReq = 5;
  const hits = (orderRateLimit.get(ip) || []).filter(t => now - t < windowMs);
  hits.push(now);
  orderRateLimit.set(ip, hits);
  return hits.length <= maxReq;
}
// 定期清理舊紀錄，避免記憶體累積
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of orderRateLimit) {
    const fresh = hits.filter(t => now - t < 60000);
    if (fresh.length === 0) orderRateLimit.delete(ip); else orderRateLimit.set(ip, fresh);
  }
}, 5 * 60 * 1000);

app.post('/api/order', async (req, res) => {
  try {
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    if (!checkOrderRate(clientIp)) {
      return res.status(429).json({ error: '下單太頻繁，請稍後再試（或直接加 LINE 下單）' });
    }
    const { serviceCode, gameId, contactId, airplane, map, note, customerName, referralCode } = req.body;
    const preferredBooster = (req.body.preferredBooster && BOOSTER_NAMES.includes(req.body.preferredBooster)) ? req.body.preferredBooster : null;

    // ── 輸入驗證 ──
    if (!serviceCode || !SERVICES[serviceCode]) {
      return res.status(400).json({ error: '無效的服務編號' });
    }
    if (!contactId || contactId.trim().length < 2) {
      return res.status(400).json({ error: '請填寫聯繫方式' });
    }
    const quantity = Math.max(1, Math.min(20, parseInt(req.body.quantity) || 1));
    const service = SERVICES[serviceCode];
    const svcName = `${serviceCode} ${service.name}`;
    const unitPrice = service.price;
    const svcGuarantee = service.guarantee;

    // ── 買五送一計算 ──
    const buy5Eligible = serviceCode && (serviceCode.startsWith('R-') || serviceCode.startsWith('C-') || serviceCode === 'G-1');  // 護航累積價值單(H-)不送；單局撤離(R-)、清圖(C-)、搬金(G-1)才送
    let paidQty = quantity;
    let freeQty = 0;
    if (buy5Eligible && quantity >= 5) {
      freeQty = Math.floor(quantity / 5);
      paidQty = quantity; // 買五送一：付全額，額外送單
    }

    let totalPrice = paidQty * unitPrice;

    // ── VIP 折扣 ──
    let vipTier = null;
    let vipDiscount = 1.0;
    if (contactId && contactId !== '未填') {
      const vip = vipData.get(contactId);
      if (vip) {
        const tier = getVipTier(vip.totalSpent);
        if (tier.discount < 1.0) {
          vipTier = tier.name;
          vipDiscount = tier.discount;
          totalPrice = Math.round(totalPrice * tier.discount);
        }
      }
    }

    // ── 推薦碼處理（VIP 和推薦碼取較優者，不疊加） ──
    let referralApplied = null;
    if (referralCode && vipDiscount >= 0.95) {
      // 只有 VIP 折扣不比推薦碼更優時才套用推薦碼
      const refData = referrals.get(referralCode.toUpperCase());
      if (refData && refData.ownerId !== contactId) {
        const isFirstOrder = !refData.referred.find(r => r.contactId === contactId);
        if (isFirstOrder) {
          if (vipDiscount >= 1.0) {
            // 無 VIP 折扣，套用推薦碼 95 折
            totalPrice = Math.round(totalPrice * 0.95);
          }
          // 有 VIP 但不比 95 折好，維持 VIP 折扣不再疊加
          referralApplied = { code: referralCode.toUpperCase(), discount: '95折', referrerName: refData.ownerName };
        }
      }
    }

    const orderId = `MC${++orderCounter}`;
    const order = {
      id: orderId, serviceCode, serviceName: svcName,
      price: totalPrice, originalPrice: unitPrice * quantity,
      guarantee: svcGuarantee,
      quantity, paidQuantity: paidQty, freeQuantity: freeQty,
      gameId: gameId || '未填', contactId: contactId || '未填',
      airplane: airplane || '未指定', map: map || '不指定',
      note: note || '無', customerName: customerName || '網站老闆',
      status: 'pending', createdAt: new Date().toISOString(),
      booster: null, boosterId: null, acceptedAt: null, completedAt: null,
      preferredBooster,
      referralCode: referralApplied ? referralApplied.code : null,
      vipTier, vipDiscount: vipDiscount < 1 ? vipDiscount : null,
    };
    await dbSaveOrder(order);
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild && channels.newOrders) {
      const ch = guild.channels.cache.get(channels.newOrders);
      if (ch) {
        const boosterRole = guild.roles.cache.find(r => r.name === 'Booster');
        const qtyInfo = order.quantity > 1 ? ` x${order.quantity}${order.freeQuantity > 0 ? `（付${order.paidQuantity}+送${order.freeQuantity}）` : ''}` : '';
        const vipInfo = order.vipTier ? `\n👑 VIP ${order.vipTier}（${Math.round(order.vipDiscount*100)}%折）` : '';
        let headDesc;
        if (order.preferredBooster) {
          const pid = boosterRegistry.get(order.preferredBooster);
          headDesc = `🎯 此單指定 **${order.preferredBooster}** 接單${pid ? `（<@${pid}>）` : '（該打手尚未報到，暫時開放任何打手接）'}，僅本人可接！`;
        } else {
          headDesc = boosterRole ? `<@&${boosterRole.id}> 有新單！` : '有新訂單！';
        }
        const embed = new EmbedBuilder().setColor(order.preferredBooster ? 0xfbbf24 : 0x00e5ff).setTitle(`🔔 新訂單 #${orderId}`)
          .setDescription(headDesc + vipInfo)
          .addFields({ name: '🛡️ 服務', value: order.serviceName + qtyInfo, inline: true },{ name: '💰 金額', value: `${order.price.toLocaleString()} T`, inline: true },{ name: '🎯 保底', value: order.guarantee || '無', inline: true },{ name: '🎮 遊戲ID', value: order.gameId, inline: true },{ name: '✈️ 飛機', value: order.airplane, inline: true },{ name: '🗺️ 地圖', value: order.map, inline: true },{ name: '📝 備註', value: order.note })
          .setFooter({ text: '點擊下方按鈕接單' }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`accept_${orderId}`).setLabel('🎮 接下此單').setStyle(ButtonStyle.Primary));
        const sentMsg = await ch.send({ embeds: [embed], components: [row] });
        orderMessages.set(orderId, { newOrder: { channelId: ch.id, messageId: sentMsg.id } });
      }
    }
    const tgQty = order.quantity > 1 ? `\n數量：${order.quantity}（付${order.paidQuantity}${order.freeQuantity > 0 ? `+送${order.freeQuantity}` : ''}）` : '';
    const tgVip = order.vipTier ? `\n👑 VIP ${order.vipTier}（${Math.round(order.vipDiscount*100)}%折）` : '';
    await sendTelegram(`🔔 新訂單 #${orderId}\n服務：${order.serviceName}\n金額：${order.price.toLocaleString()} T${order.originalPrice !== order.price ? `（原價 ${order.originalPrice.toLocaleString()} T）` : ''}${tgQty}${tgVip}${order.preferredBooster ? `\n🎯 指定打手：${order.preferredBooster}` : ''}\n保底：${order.guarantee || '無'}\n遊戲ID：${order.gameId}\n聯繫：${order.contactId}${referralApplied ? `\n🤝 推薦碼：${referralApplied.code}（推薦人：${referralApplied.referrerName}）` : ''}`);
    await sendLineOrderNotify(order);
    res.json({ success: true, orderId, message: `訂單 ${orderId} 已建立`, referral: referralApplied, vipTier: order.vipTier, vipDiscount: order.vipDiscount, totalPrice: order.price, quantity: order.quantity, paidQuantity: order.paidQuantity, freeQuantity: order.freeQuantity });
  } catch (e) { console.error('訂單錯誤:', e); res.status(500).json({ error: '伺服器錯誤' }); }
});

app.get('/api/order/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  // 只回傳進度資訊，移除客人個資(遊戲ID/聯絡方式/客名/備註)避免枚舉外洩
  const safe = JSON.parse(JSON.stringify(order));
  delete safe.gameId; delete safe.contactId; delete safe.customerName; delete safe.note; delete safe.boosterId;
  if (safe.booster) safe.booster = safe.booster.replace(/(.{1}).*/, '$1***');
  res.json(safe);
});
// ⚠️ 管理員專用：需在 Railway 設 ADMIN_KEY，並帶 ?key=<ADMIN_KEY> 才能存取
app.get('/api/orders', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  res.json([...orders.values()].reverse());
});
app.get('/api/stats', (req, res) => {
  const all = [...orders.values()];
  res.json({ total: all.length, pending: all.filter(o => o.status === 'pending').length, active: all.filter(o => o.status === 'active').length, completed: all.filter(o => o.status === 'completed').length }); // 移除 totalRevenue：不對外公開營收
});

app.get('/api/live-orders', (req, res) => {
  const recent = [...orders.values()]
    .filter(o => o.status === 'completed')
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, 10)
    .map(o => ({
      id: o.id, service: o.serviceName, price: o.price,
      booster: o.booster ? o.booster.replace(/(.{2}).*(.{2})/, '$1***$2') : '未知',
      completedAt: o.completedAt, timeDiff: getTimeDiff(o.acceptedAt, o.completedAt),
    }));
  res.json(recent);
});

app.get('/api/vip/:contactId', (req, res) => {
  const data = vipData.get(req.params.contactId);
  if (!data) return res.json({ found: false, tier: 'Rookie', totalSpent: 0, discount: '原價', discountNum: 1.0, orders: [] });
  const tier = getVipTier(data.totalSpent);
  res.json({
    found: true, tier: tier.name, emoji: tier.emoji, totalSpent: data.totalSpent,
    discount: tier.discount === 1 ? '原價' : `${Math.round(tier.discount * 100)}%`,
    discountNum: tier.discount,
    orderCount: data.orders.length, recentOrders: (data.orders || []).slice(-5).reverse(),
    nextTier: VIP_TIERS[VIP_TIERS.indexOf(tier) - 1] || null,
  });
});

app.get('/api/services', (req, res) => { res.json(SERVICES); });
app.get('/api/leaderboard', (req, res) => {
  const sorted = [...boosterStats.entries()].sort((a, b) => b[1].completed - a[1].completed).slice(0, 10)
    .map(([tag, s], i) => ({ rank: i + 1, name: tag, completed: s.completed })); // 移除 revenue：不公開打手營收
  res.json(sorted);
});
app.get('/api/tickets', (req, res) => { if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'forbidden' }); res.json([...tickets.values()].reverse().slice(0, 20)); });

// ============================================================
// 🤝 推薦系統 API
// ============================================================

app.post('/api/referral/create', async (req, res) => {
  const { contactId, name } = req.body;
  if (!contactId) return res.status(400).json({ error: '請提供聯繫ID' });
  if (referralByContact.has(contactId)) {
    const code = referralByContact.get(contactId);
    return res.json({ success: true, code, existing: true, data: referrals.get(code) });
  }
  const code = generateReferralCode(name || contactId);
  const data = {
    code, ownerId: contactId, ownerName: name || contactId,
    referred: [], totalReferred: 0, milestone: null,
    coupons: [], permDiscount: null, createdAt: new Date().toISOString(),
  };
  await dbSaveReferral(code, data);
  res.json({ success: true, code, existing: false, data });
});

app.get('/api/referral/:code', (req, res) => {
  const data = referrals.get(req.params.code.toUpperCase());
  if (!data) return res.status(404).json({ error: '找不到此推薦碼' });
  const milestone = checkMilestone(data);
  res.json({
    code: data.code, ownerName: data.ownerName,
    totalReferred: data.totalReferred,
    currentMilestone: milestone ? milestone.name : '尚未達成',
    nextMilestone: REFERRAL_MILESTONES.find(m => m.count > data.totalReferred) || null,
    coupons: data.coupons, permDiscount: data.permDiscount,
    referred: data.referred.map(r => ({ name: r.name, date: r.date, orderAmount: r.orderAmount })),
  });
});

app.get('/api/referral-leaderboard', (req, res) => {
  const sorted = [...referrals.values()]
    .sort((a, b) => b.totalReferred - a.totalReferred)
    .slice(0, 10)
    .map((r, i) => ({
      rank: i + 1, name: r.ownerName, referred: r.totalReferred,
      milestone: checkMilestone(r)?.name || '無',
    }));
  res.json(sorted);
});

app.get('/api/referral-milestones', (req, res) => {
  res.json(REFERRAL_MILESTONES);
});

function getTimeDiff(start, end) { if (!start || !end) return '未知'; const diff = new Date(end) - new Date(start); const hours = Math.floor(diff / 3600000); const mins = Math.floor((diff % 3600000) / 60000); if (hours > 0) return `${hours}h ${mins}m`; return `${mins}m`; }


// ── 啟動 ──
(async () => {
  await connectMongo();
  app.listen(PORT, () => { console.log(`🌐 API v3.3 運行中：port ${PORT} | MongoDB: ${mongoReady ? '✅' : '❌ 記憶體模式'}`); });
  client.login(DISCORD_TOKEN).catch(e => { console.error('Discord 登入失敗:', e.message); process.exit(1); });
})();
