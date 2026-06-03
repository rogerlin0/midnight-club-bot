// ============================================================
// 🌙 午夜俱樂部 MK-01 自動接單系統 v2.0
// Discord Bot + Telegram 通知 + 網站 API + 每日報表
// ============================================================

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits,
  StringSelectMenuBuilder } = require('discord.js');
const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');

// ── 環境變數 ──
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3000;

// ── 訂單資料庫（記憶體，重啟會清空，正式版可接 MongoDB） ──
const orders = new Map();
let orderCounter = 1000;
const dailyStats = { revenue: 0, count: 0, services: {} };

// ── 頻道 ID 快取 ──
const channels = {};

// ── 服務報價表 ──
const SERVICES = {
  'E-1': { name: '護航①', price: 750, guarantee: '1,388萬' },
  'E-2': { name: '護航②', price: 1200, guarantee: '2,588萬' },
  'E-3': { name: '護航③', price: 1700, guarantee: '3,788萬' },
  'E-4': { name: '護航④', price: 2200, guarantee: '4,888萬' },
  'E-5': { name: '護航⑤', price: 3200, guarantee: '7,388萬' },
  'E-6': { name: '護航⑥', price: 4000, guarantee: '1億' },
  'E-7': { name: '護航⑦', price: 6000, guarantee: '1.5億' },
  'E-8': { name: '護航⑧', price: 7900, guarantee: '2億' },
  'C-1': { name: '電台清圖', price: 520, guarantee: null },
  'C-2': { name: '王牌清圖', price: 1000, guarantee: null },
  'C-3': { name: '主教練上場', price: 1200, guarantee: null },
  'I-1': { name: '摸保險 10個', price: 800, guarantee: '1,000萬' },
  'I-2': { name: '摸保險 50個', price: 4000, guarantee: '4,500萬' },
  'I-3': { name: '摸保險 100個', price: 7000, guarantee: '8,000萬' },
  'G-1': { name: '單局單大金', price: 550, guarantee: null },
  'G-2': { name: '單局帶出1500萬', price: 6888, guarantee: '3,888萬' },
  'G-3': { name: '指定任意大金', price: 5400, guarantee: null },
  'S-1': { name: '機密文件', price: 4100, guarantee: '6,888萬' },
  'S-2': { name: '理想國', price: 2680, guarantee: '3,999萬' },
  'A-1': { name: 'S5 3x3代肝', price: 2800, guarantee: null },
  'A-2': { name: '單日代肝8H', price: 1200, guarantee: null },
  'A-3': { name: '週套餐代肝', price: 7500, guarantee: null },
  'P-1': { name: '技術男陪/H', price: 350, guarantee: null },
  'P-2': { name: '娛樂女陪/H', price: 350, guarantee: null },
  'P-3': { name: '長時陪做套餐', price: 3688, guarantee: null },
  'P-4': { name: '任務救急', price: 260, guarantee: null },
};

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
  console.log(`🌙 MK-01 已上線：${client.user.tag}`);
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return console.error('找不到伺服器！');

  // 快取或建立頻道
  await setupChannels(guild);

  // 發送上線通知
  if (channels.announcements) {
    const ch = guild.channels.cache.get(channels.announcements);
    if (ch) {
      const embed = new EmbedBuilder()
        .setColor(0x00e5ff)
        .setTitle('🌙 MK-01 接單系統已上線')
        .setDescription('自動接單系統運行中，所有新訂單將自動推送到此伺服器。')
        .setTimestamp();
      ch.send({ embeds: [embed] });
    }
  }
});

// ── 自動建立頻道與角色 ──
async function setupChannels(guild) {
  // ── 分類定義 ──
  const categoryDefs = [
    { key: 'catPublic', name: '🎮 暗區社群（公開）' },
    { key: 'catVoice', name: '🔊 語音頻道' },
    { key: 'catBusiness', name: '🌙 午夜俱樂部（接單）' },
    { key: 'catInternal', name: '🔒 內部管理' },
  ];

  // ── 頻道定義（含分類歸屬） ──
  const channelDefs = [
    // 公開社群區 — 所有人可見，吸引玩家
    { key: 'welcome', name: '👋｜歡迎光臨', topic: '新人必看！俱樂部介紹與規則', cat: 'catPublic' },
    { key: 'announcements', name: '📢｜公告', topic: '系統公告與重要通知', cat: 'catPublic' },
    { key: 'chat', name: '💬｜閒聊吹水', topic: '暗區玩家自由聊天', cat: 'catPublic' },
    { key: 'gameChat', name: '🔫｜暗區攻略', topic: '地圖攻略、武器討論、打法分享', cat: 'catPublic' },
    { key: 'showoff', name: '🏆｜戰績曬單', topic: '曬你的大金、神裝、滿載撤離！', cat: 'catPublic' },
    { key: 'memes', name: '😂｜迷因梗圖', topic: '暗區搞笑圖片影片', cat: 'catPublic' },
    { key: 'lfg', name: '🎯｜組隊找人', topic: '找人一起打暗區', cat: 'catPublic' },
    { key: 'priceList', name: '💰｜報價表', topic: '代練服務報價一覽（唯讀）', cat: 'catPublic' },
    { key: 'reviews', name: '⭐｜好評曬單', topic: '客戶完成截圖與好評', cat: 'catPublic' },
    // 語音頻道區 — 分三層：一般玩家 / 老闆專屬 / VIP 尊享
    // 一般玩家（所有人可進）
    { key: 'vcLobby', name: '🔊｜大廳聊天', topic: null, cat: 'catVoice', voice: true },
    { key: 'vcTeam1', name: '🎯｜組隊 1', topic: null, cat: 'catVoice', voice: true },
    { key: 'vcTeam2', name: '🎯｜組隊 2', topic: null, cat: 'catVoice', voice: true },
    { key: 'vcTeam3', name: '🎯｜組隊 3', topic: null, cat: 'catVoice', voice: true },
    { key: 'vcChill', name: '🎵｜音樂放鬆', topic: null, cat: 'catVoice', voice: true },
    // 老闆專屬（客戶角色以上）
    { key: 'vcBoss1', name: '🎮｜老闆開黑 1', topic: null, cat: 'catVoice', voice: true, clientOnly: true },
    { key: 'vcBoss2', name: '🎮｜老闆開黑 2', topic: null, cat: 'catVoice', voice: true, clientOnly: true },
    { key: 'vcBoost1', name: '🛡️｜代練作業 1', topic: null, cat: 'catVoice', voice: true, clientOnly: true },
    { key: 'vcBoost2', name: '🛡️｜代練作業 2', topic: null, cat: 'catVoice', voice: true, clientOnly: true },
    // VIP 尊享（VIP 角色限定）
    { key: 'vcVip1', name: '👑｜VIP 包廂 1', topic: null, cat: 'catVoice', voice: true, vipOnly: true },
    { key: 'vcVip2', name: '👑｜VIP 包廂 2', topic: null, cat: 'catVoice', voice: true, vipOnly: true },
    { key: 'vcVipRanked', name: '💎｜VIP 競技房', topic: null, cat: 'catVoice', voice: true, vipOnly: true },
    // 接單系統 — 客戶與打手互動
    { key: 'newOrders', name: '🔔｜新訂單', topic: '新訂單自動推送，打手在此接單', cat: 'catBusiness' },
    { key: 'activeOrders', name: '⚡｜進行中', topic: '已接受的訂單追蹤', cat: 'catBusiness' },
    { key: 'completed', name: '✅｜已完成', topic: '完成的訂單紀錄', cat: 'catBusiness' },
    { key: 'customerLobby', name: '🎮｜老闆大廳', topic: '下單客戶聊天與溝通', cat: 'catBusiness' },
    { key: 'vipLounge', name: '👑｜VIP專區', topic: 'VIP 會員專屬頻道', cat: 'catBusiness' },
    // 內部管理 — 僅 Boss 和 Booster 可見
    { key: 'boosterChat', name: '💬｜打手聊天', topic: '打手內部溝通', cat: 'catInternal' },
    { key: 'dailyStats', name: '📊｜每日報表', topic: '每日自動業務摘要', cat: 'catInternal' },
    { key: 'adminLog', name: '📋｜管理日誌', topic: '系統操作紀錄', cat: 'catInternal' },
  ];

  // 建立角色（如果不存在）
  const roleDefs = [
    { name: 'Boss', color: 0xf43f5e, hoist: true },
    { name: 'Booster', color: 0xfbbf24, hoist: true },
    { name: 'VIP客戶', color: 0x8b5cf6, hoist: true },
    { name: '客戶', color: 0x6b7280, hoist: false },
  ];

  for (const rd of roleDefs) {
    const existing = guild.roles.cache.find(r => r.name === rd.name);
    if (!existing) {
      await guild.roles.create({
        name: rd.name,
        color: rd.color,
        hoist: rd.hoist,
        reason: 'MK-01 自動建立'
      });
      console.log(`✅ 已建立角色：${rd.name}`);
    }
  }

  // 建立分類
  const categories = {};
  for (const catDef of categoryDefs) {
    let cat = guild.channels.cache.find(
      c => c.name === catDef.name && c.type === ChannelType.GuildCategory
    );
    if (!cat) {
      const boosterRole = guild.roles.cache.find(r => r.name === 'Booster');
      const bossRole = guild.roles.cache.find(r => r.name === 'Boss');
      const perms = [];

      // 內部管理分類：僅 Boss 和 Booster 可見
      if (catDef.key === 'catInternal') {
        perms.push(
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        );
        if (boosterRole) perms.push({ id: boosterRole.id, allow: [PermissionFlagsBits.ViewChannel] });
        if (bossRole) perms.push({ id: bossRole.id, allow: [PermissionFlagsBits.ViewChannel] });
      }

      cat = await guild.channels.create({
        name: catDef.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: perms.length ? perms : undefined,
        reason: 'MK-01 自動建立'
      });
      console.log(`✅ 已建立分類：${catDef.name}`);
    }
    categories[catDef.key] = cat.id;
  }

  // 建立頻道
  for (const cd of channelDefs) {
    const parentId = categories[cd.cat] || categories.catPublic;
    const chType = cd.voice ? ChannelType.GuildVoice : ChannelType.GuildText;
    let ch = guild.channels.cache.find(
      c => c.name === cd.name && c.parentId === parentId
    );
    if (!ch) {
      const chPerms = [];
      // 報價表設為唯讀
      if (cd.key === 'priceList') {
        chPerms.push({ id: guild.id, deny: [PermissionFlagsBits.SendMessages] });
      }
      // 老闆專屬（客戶+VIP+Booster+Boss 可見，一般玩家不可見）
      if (cd.clientOnly) {
        const clientRole = guild.roles.cache.find(r => r.name === '客戶');
        const vipRole = guild.roles.cache.find(r => r.name === 'VIP客戶');
        const bossRole = guild.roles.cache.find(r => r.name === 'Boss');
        const boosterRole = guild.roles.cache.find(r => r.name === 'Booster');
        chPerms.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
        if (clientRole) chPerms.push({ id: clientRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
        if (vipRole) chPerms.push({ id: vipRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
        if (bossRole) chPerms.push({ id: bossRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
        if (boosterRole) chPerms.push({ id: boosterRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
      }
      // VIP 尊享（僅 VIP+Boss+Booster 可見）
      if (cd.key === 'vipLounge' || cd.vipOnly) {
        const vipRole = guild.roles.cache.find(r => r.name === 'VIP客戶');
        const bossRole = guild.roles.cache.find(r => r.name === 'Boss');
        const boosterRole = guild.roles.cache.find(r => r.name === 'Booster');
        chPerms.push({ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] });
        if (vipRole) chPerms.push({ id: vipRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
        if (bossRole) chPerms.push({ id: bossRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
        if (boosterRole) chPerms.push({ id: boosterRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
      }

      const opts = {
        name: cd.name,
        type: chType,
        parent: parentId,
        permissionOverwrites: chPerms.length ? chPerms : undefined,
        reason: 'MK-01 自動建立'
      };
      if (cd.topic && !cd.voice) opts.topic = cd.topic;
      // 語音頻道設定人數上限
      if (cd.voice && (cd.key.startsWith('vcTeam') || cd.key.startsWith('vcBoost'))) {
        opts.userLimit = 5; // 暗區突圍最多 5 人一隊
      }

      ch = await guild.channels.create(opts);
      console.log(`✅ 已建立${cd.voice ? '語音' : '文字'}頻道：${cd.name}`);
    }
    channels[cd.key] = ch.id;
  }

  // ── 自動發送歡迎訊息到 #welcome ──
  if (channels.welcome) {
    const wCh = guild.channels.cache.get(channels.welcome);
    if (wCh) {
      const msgs = await wCh.messages.fetch({ limit: 1 });
      if (msgs.size === 0) {
        const embed = new EmbedBuilder()
          .setColor(0x8b5cf6)
          .setTitle('🌙 歡迎來到午夜俱樂部')
          .setDescription(
            '**暗區突圍：無限** 最強代練俱樂部\n\n' +
            '🛡️ 護航帶刷 · 🧹 清圖開局 · 🎲 摸保險\n' +
            '💰 對賭大金 · 🧬 3x3代肝 · 🎮 陪玩\n\n' +
            '━━━━━━━━━━━━━━\n' +
            '**頻道導覽：**\n' +
            '💬 `閒聊吹水` — 自由聊天\n' +
            '🔫 `暗區攻略` — 地圖、武器、打法討論\n' +
            '🏆 `戰績曬單` — 曬你的戰績！\n' +
            '🎯 `組隊找人` — 找隊友一起打\n' +
            '💰 `報價表` — 代練服務報價\n' +
            '⭐ `好評曬單` — 看看其他老闆的評價\n\n' +
            '━━━━━━━━━━━━━━\n' +
            '**想下單？** 到 `💰報價表` 看服務，或直接加 LINE：**23roger02**\n' +
            '**追繳三重賠付** — 全額退 + 1000T + 2625點卷！'
          )
          .setFooter({ text: '純綠玩 · 全程可直播 · 自家打手不外聘' });
        wCh.send({ embeds: [embed] });
      }
    }
  }

  // ── 自動發送報價表到 #priceList ──
  if (channels.priceList) {
    const pCh = guild.channels.cache.get(channels.priceList);
    if (pCh) {
      const msgs = await pCh.messages.fetch({ limit: 1 });
      if (msgs.size === 0) {
        const e1 = new EmbedBuilder().setColor(0x00e5ff).setTitle('🛡️ 護航單（包鑰匙·不卡保底·無封頂·追繳三重賠付）')
          .setDescription('```\nE-1  750T  → 保底 1,388萬\nE-2  1,200T → 保底 2,588萬\nE-3  1,700T → 保底 3,788萬\nE-4  2,200T → 保底 4,888萬 🔥\nE-5  3,200T → 保底 7,388萬 🔥\nE-6  4,000T → 保底 1億\nE-7  6,000T → 保底 1.5億\nE-8  7,900T → 保底 2億\n```\n🎁 護航買五送一！');
        const e2 = new EmbedBuilder().setColor(0xfbbf24).setTitle('🧹 清圖 · 🎲 摸保險 · 💰 對賭')
          .setDescription('```\n清圖：\nC-1 電台    520T/局\nC-2 王牌  1,000T/局 🔥\nC-3 主教練 1,200T/局\n\n摸保險：\nI-1  10個   800T → 保底 1,000萬\nI-2  50個  4,000T → 保底 4,500萬\nI-3 100個  7,000T → 保底 8,000萬\n\n對賭：\nG-1 單局單大金     550T\nG-2 帶出1500萬  6,888T 🔥\nG-3 指定大金    5,400T\n```');
        const e3 = new EmbedBuilder().setColor(0xec4899).setTitle('🗺️ 特殊地圖 · 🧬 代肝 · 🎮 陪玩')
          .setDescription('```\n特殊地圖：\nS-1 機密文件 4,100T → 保底 6,888萬 🔥\nS-2 理想國   2,680T → 保底 3,999萬 🔥\n\n代肝：\nA-1 S5 3x3  2,800T（3天60任務）🔥\nA-2 單日8H  1,200T\nA-3 週套餐  7,500T\n\n陪玩：\nP-1 男陪 350T/H\nP-2 女陪 350T/H\nP-3 套餐 3,688T（10H+60任務）🔥\nP-4 救急 260T\n```');
        const e4 = new EmbedBuilder().setColor(0x34d399).setTitle('📋 下單方式')
          .setDescription('**報編號就能下單！**\n\n1️⃣ 記住你要的編號（如 E-4、C-2）\n2️⃣ 加 LINE：**23roger02**\n3️⃣ 報編號，秒回確認\n4️⃣ LINE Pay / 街口 / 轉帳\n\n🔥 **追繳三重賠付：全額退 + 1000T + 2625點卷**');
        await pCh.send({ embeds: [e1, e2, e3, e4] });
      }
    }
  }

  console.log('🌙 頻道設定完成');
}

// ── 處理按鈕互動（打手接單/完成） ──
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const [action, orderId] = interaction.customId.split('_');
  const order = orders.get(orderId);

  if (!order) {
    return interaction.reply({ content: '❌ 找不到此訂單', ephemeral: true });
  }

  const guild = interaction.guild;

  if (action === 'accept') {
    if (order.status !== 'pending') {
      return interaction.reply({ content: '⚠️ 此訂單已被其他打手接走', ephemeral: true });
    }

    order.status = 'active';
    order.booster = interaction.user.tag;
    order.boosterId = interaction.user.id;
    order.acceptedAt = new Date().toISOString();

    // 更新原始訊息
    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0xfbbf24)
      .addFields({ name: '🎮 接單打手', value: interaction.user.tag })
      .setTitle(`⚡ 訂單 #${orderId} — 進行中`);

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`done_${orderId}`).setLabel('✅ 完成訂單').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`problem_${orderId}`).setLabel('⚠️ 回報問題').setStyle(ButtonStyle.Danger),
    );

    await interaction.update({ embeds: [embed], components: [disabledRow] });

    // 發到進行中頻道
    if (channels.activeOrders) {
      const activeCh = guild.channels.cache.get(channels.activeOrders);
      if (activeCh) {
        const activeEmbed = new EmbedBuilder()
          .setColor(0xfbbf24)
          .setTitle(`⚡ 訂單 #${orderId} 已開始`)
          .addFields(
            { name: '服務', value: order.serviceName, inline: true },
            { name: '金額', value: `${order.price} T`, inline: true },
            { name: '打手', value: interaction.user.tag, inline: true },
            { name: '老闆', value: order.customerName || '未知', inline: true },
          )
          .setTimestamp();
        activeCh.send({ embeds: [activeEmbed] });
      }
    }

    // Telegram 通知 Roger
    await sendTelegram(
      `⚡ 訂單 #${orderId} 已被接單\n` +
      `打手：${interaction.user.tag}\n` +
      `服務：${order.serviceName}\n` +
      `金額：${order.price} T`
    );

    await interaction.followUp({ content: `✅ 你已接下訂單 #${orderId}，開始作業吧！`, ephemeral: true });
  }

  if (action === 'done') {
    if (order.boosterId !== interaction.user.id) {
      return interaction.reply({ content: '❌ 只有接單打手可以完成此訂單', ephemeral: true });
    }

    order.status = 'completed';
    order.completedAt = new Date().toISOString();

    // 更新統計
    dailyStats.revenue += order.price;
    dailyStats.count += 1;
    dailyStats.services[order.serviceCode] = (dailyStats.services[order.serviceCode] || 0) + 1;

    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0x34d399)
      .setTitle(`✅ 訂單 #${orderId} — 已完成`);

    await interaction.update({ embeds: [embed], components: [] });

    // 發到完成頻道
    if (channels.completed) {
      const compCh = guild.channels.cache.get(channels.completed);
      if (compCh) {
        const compEmbed = new EmbedBuilder()
          .setColor(0x34d399)
          .setTitle(`✅ 訂單 #${orderId} 完成`)
          .addFields(
            { name: '服務', value: order.serviceName, inline: true },
            { name: '金額', value: `${order.price} T`, inline: true },
            { name: '打手', value: order.booster, inline: true },
            { name: '耗時', value: getTimeDiff(order.acceptedAt, order.completedAt), inline: true },
          )
          .setTimestamp();
        compCh.send({ embeds: [compEmbed] });
      }
    }

    // Telegram 通知
    await sendTelegram(
      `✅ 訂單 #${orderId} 已完成\n` +
      `服務：${order.serviceName}\n` +
      `金額：${order.price} T\n` +
      `打手：${order.booster}\n` +
      `耗時：${getTimeDiff(order.acceptedAt, order.completedAt)}`
    );
  }

  if (action === 'problem') {
    await interaction.reply({
      content: `⚠️ 訂單 #${orderId} 問題回報已通知 Roger，請在 <#${channels.boosterChat}> 說明詳情。`,
      ephemeral: true
    });
    await sendTelegram(
      `⚠️ 訂單 #${orderId} 有問題！\n` +
      `打手：${interaction.user.tag}\n` +
      `服務：${order.serviceName}\n` +
      `請盡快處理！`
    );
  }
});

// ============================================================
// Telegram 發送
// ============================================================
async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text: `🌙 午夜俱樂部\n━━━━━━━━━━\n${text}`,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('Telegram 發送失敗:', e.message);
  }
}

// ============================================================
// 每日報表（每晚 23:00）
// ============================================================
cron.schedule('0 23 * * *', async () => {
  const today = new Date().toLocaleDateString('zh-TW');

  // 計算今日數據
  const completedToday = [...orders.values()].filter(o =>
    o.status === 'completed' && o.completedAt && o.completedAt.startsWith(new Date().toISOString().slice(0, 10))
  );
  const pendingCount = [...orders.values()].filter(o => o.status === 'pending').length;
  const activeCount = [...orders.values()].filter(o => o.status === 'active').length;

  const totalRevenue = completedToday.reduce((sum, o) => sum + o.price, 0);
  const serviceBreakdown = {};
  completedToday.forEach(o => {
    serviceBreakdown[o.serviceName] = (serviceBreakdown[o.serviceName] || 0) + 1;
  });

  const breakdownStr = Object.entries(serviceBreakdown)
    .map(([k, v]) => `  ${k}: ${v} 單`)
    .join('\n') || '  （無）';

  const report =
    `📊 每日業務報表 — ${today}\n` +
    `━━━━━━━━━━━━━━\n` +
    `✅ 今日完成：${completedToday.length} 單\n` +
    `💰 今日營收：${totalRevenue.toLocaleString()} T\n` +
    `⚡ 進行中：${activeCount} 單\n` +
    `🔔 待接單：${pendingCount} 單\n` +
    `━━━━━━━━━━━━━━\n` +
    `📋 服務明細：\n${breakdownStr}\n` +
    `━━━━━━━━━━━━━━\n` +
    `累計總訂單：${orders.size} 單`;

  // 發到 Telegram
  await sendTelegram(report);

  // 發到 Discord #daily-stats
  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild && channels.dailyStats) {
    const statsCh = guild.channels.cache.get(channels.dailyStats);
    if (statsCh) {
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(`📊 每日報表 — ${today}`)
        .addFields(
          { name: '✅ 完成', value: `${completedToday.length} 單`, inline: true },
          { name: '💰 營收', value: `${totalRevenue.toLocaleString()} T`, inline: true },
          { name: '⚡ 進行中', value: `${activeCount} 單`, inline: true },
          { name: '🔔 待接', value: `${pendingCount} 單`, inline: true },
          { name: '📋 明細', value: breakdownStr },
        )
        .setTimestamp();
      statsCh.send({ embeds: [embed] });
    }
  }

  // 重置日統計
  dailyStats.revenue = 0;
  dailyStats.count = 0;
  dailyStats.services = {};
}, { timezone: 'Asia/Taipei' });

// ============================================================
// Express API（接收網站訂單）
// ============================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 健康檢查
app.get('/', (req, res) => {
  res.json({
    status: '🌙 MK-01 Online',
    orders: orders.size,
    uptime: process.uptime()
  });
});

// ── 新訂單 API ──
app.post('/api/order', async (req, res) => {
  try {
    const { serviceCode, gameId, contactId, airplane, map, note, customerName } = req.body;

    const service = SERVICES[serviceCode];
    if (!service) {
      return res.status(400).json({ error: '無效的服務編號' });
    }

    const orderId = `MC${++orderCounter}`;
    const order = {
      id: orderId,
      serviceCode,
      serviceName: `${serviceCode} ${service.name}`,
      price: service.price,
      guarantee: service.guarantee,
      gameId: gameId || '未填',
      contactId: contactId || '未填',
      airplane: airplane || '未指定',
      map: map || '不指定',
      note: note || '無',
      customerName: customerName || '網站老闆',
      status: 'pending',
      createdAt: new Date().toISOString(),
      booster: null,
      boosterId: null,
      acceptedAt: null,
      completedAt: null,
    };

    orders.set(orderId, order);

    // ── Discord 新訂單通知 ──
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild && channels.newOrders) {
      const ch = guild.channels.cache.get(channels.newOrders);
      if (ch) {
        const boosterRole = guild.roles.cache.find(r => r.name === 'Booster');

        const embed = new EmbedBuilder()
          .setColor(0x00e5ff)
          .setTitle(`🔔 新訂單 #${orderId}`)
          .setDescription(boosterRole ? `<@&${boosterRole.id}> 有新單！` : '有新訂單！')
          .addFields(
            { name: '🛡️ 服務', value: order.serviceName, inline: true },
            { name: '💰 金額', value: `${order.price} T`, inline: true },
            { name: '🎯 保底', value: order.guarantee || '無', inline: true },
            { name: '🎮 遊戲ID', value: order.gameId, inline: true },
            { name: '✈️ 飛機', value: order.airplane, inline: true },
            { name: '🗺️ 地圖', value: order.map, inline: true },
            { name: '📝 備註', value: order.note },
          )
          .setFooter({ text: '點擊下方按鈕接單' })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`accept_${orderId}`)
            .setLabel('🎮 接下此單')
            .setStyle(ButtonStyle.Primary),
        );

        ch.send({ embeds: [embed], components: [row] });
      }
    }

    // ── Telegram 通知 Roger ──
    await sendTelegram(
      `🔔 新訂單 #${orderId}\n` +
      `━━━━━━━━━━\n` +
      `服務：${order.serviceName}\n` +
      `金額：${order.price} T\n` +
      `保底：${order.guarantee || '無'}\n` +
      `遊戲ID：${order.gameId}\n` +
      `聯繫：${order.contactId}\n` +
      `飛機：${order.airplane}\n` +
      `地圖：${order.map}\n` +
      `備註：${order.note}`
    );

    res.json({ success: true, orderId, message: `訂單 ${orderId} 已建立` });
  } catch (e) {
    console.error('訂單錯誤:', e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── 查詢訂單 ──
app.get('/api/order/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  res.json(order);
});

// ── 所有訂單（管理用）──
app.get('/api/orders', (req, res) => {
  res.json([...orders.values()].reverse());
});

// ── 統計 ──
app.get('/api/stats', (req, res) => {
  const all = [...orders.values()];
  res.json({
    total: all.length,
    pending: all.filter(o => o.status === 'pending').length,
    active: all.filter(o => o.status === 'active').length,
    completed: all.filter(o => o.status === 'completed').length,
    totalRevenue: all.filter(o => o.status === 'completed').reduce((s, o) => s + o.price, 0),
  });
});

// ============================================================
// 工具函式
// ============================================================
function getTimeDiff(start, end) {
  if (!start || !end) return '未知';
  const diff = new Date(end) - new Date(start);
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ============================================================
// 啟動
// ============================================================
app.listen(PORT, () => {
  console.log(`🌐 API 伺服器運行中：port ${PORT}`);
});

client.login(DISCORD_TOKEN).catch(e => {
  console.error('Discord 登入失敗:', e.message);
  process.exit(1);
});
