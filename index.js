export default {
  async fetch(request, env, ctx) {
    if (request.method === 'POST') {
      try {
        const update = await request.json();

        if (update.message) {
          await handleMessage(update.message, env);
        } else if (update.callback_query) {
          await handleCallbackQuery(update.callback_query, env);
        }
      } catch (e) {
        console.error("Error processing update:", e);
      }
      return new Response('OK', { status: 200 });
    }

    const url = new URL(request.url);

    return new Response('PIN BOX Bot is running!', { status: 200 });
  },
};

const defaultKeyboard = {
  keyboard: [
    [{ text: "📂 ငါ့ရဲ့ဖိုင်များ (My Files)" }, { text: "ℹ️ အသုံးပြုနည်း (Help)" }]
  ],
  resize_keyboard: true
};

async function findFile(db, key) {
  let row = await db.prepare("SELECT * FROM files WHERE file_id = ?").bind(key).first();
  if (row) return row;
  row = await db.prepare("SELECT * FROM files WHERE custom_link = ?").bind(key).first();
  return row;
}

function getShareKey(fileRow) {
  return fileRow.custom_link || fileRow.file_id;
}

function extractFileInfo(message) {
  if (message.document) {
    return { fileId: message.document.file_id, mediaType: 'document', caption: message.caption || null };
  } else if (message.photo) {

    return { fileId: message.photo[message.photo.length - 1].file_id, mediaType: 'photo', caption: message.caption || null };
  } else if (message.video) {
    return { fileId: message.video.file_id, mediaType: 'video', caption: message.caption || null };
  } else if (message.audio) {
    return { fileId: message.audio.file_id, mediaType: 'audio', caption: message.caption || null };
  } else if (message.voice) {
    return { fileId: message.voice.file_id, mediaType: 'voice', caption: message.caption || null };
  } else if (message.animation) {
    return { fileId: message.animation.file_id, mediaType: 'animation', caption: message.caption || null };
  }
  return null;
}

async function sendFileById(token, chatId, fileId, mediaType, options = {}) {
  const methodMap = {
    'document': 'sendDocument',
    'photo': 'sendPhoto',
    'video': 'sendVideo',
    'audio': 'sendAudio',
    'voice': 'sendVoice',
    'animation': 'sendAnimation'
  };
  const fieldMap = {
    'document': 'document',
    'photo': 'photo',
    'video': 'video',
    'audio': 'audio',
    'voice': 'voice',
    'animation': 'animation'
  };
  const method = methodMap[mediaType] || 'sendDocument';
  const field = fieldMap[mediaType] || 'document';

  const body = { chat_id: chatId, [field]: fileId, ...options };
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await res.json();
}

async function deliverFile(env, chatId, fileRow) {
  const protectOpts = fileRow.anti_leak ? { protect_content: true } : {};
  const captionOpts = fileRow.caption ? { caption: fileRow.caption } : {};

  if (fileRow.telegram_file_id && fileRow.media_type) {
    const res = await sendFileById(env.BOT_TOKEN, chatId, fileRow.telegram_file_id, fileRow.media_type, { ...protectOpts, ...captionOpts });
    if (res.ok) return true;
  }
  return false;
}

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const text = message.text || '';
  const botInfo = await getMe(env.BOT_TOKEN);
  const botUsername = botInfo.username;

  if (text.startsWith('/')) {
    await env.DB.prepare('DELETE FROM states WHERE chat_id = ?').bind(chatId).run();
    if (text === '/cancel') {
      await sendMessage(env.BOT_TOKEN, chatId, "လုပ်ဆောင်မှု ရပ်ဆိုင်းလိုက်ပါပြီ။", { reply_markup: defaultKeyboard });
      return;
    }

  }

  if (!text.startsWith('/')) {
    const stateRow = await env.DB.prepare("SELECT action, file_key FROM states WHERE chat_id = ? AND created_at > datetime('now', '-5 minutes')").bind(chatId).first();
    if (stateRow) {
      if (stateRow.action === 'awaiting_pin') {
        const fileRow = await env.DB.prepare("SELECT * FROM files WHERE file_id = ?").bind(stateRow.file_key).first();
        if (fileRow && text === fileRow.pin) {
          await env.DB.prepare('DELETE FROM states WHERE chat_id = ?').bind(chatId).run();

          const sent = await deliverFile(env, chatId, fileRow);
          if (!sent) {
            await sendMessage(env.BOT_TOKEN, chatId, "❌ ဖိုင်ကို ပြန်လည်ရယူရာတွင် အခက်အခဲရှိနေပါသည်။");
            return;
          }

          if (fileRow.burn) {
            await env.DB.prepare("DELETE FROM files WHERE file_id = ?").bind(stateRow.file_key).run();
            await sendMessage(env.BOT_TOKEN, chatId, "🔥 <i>ဒီဖိုင်ဟာ တစ်ခါကြည့် (Burn) အဖြစ် သတ်မှတ်ထားလို့ အခု ဖွင့်ကြည့်ပြီးတာနဲ့ အလိုအလျောက် အပြီးတိုင် ဖျက်ပစ်လိုက်ပါပြီ။ နောက်တစ်ကြိမ် ပြန်ကြည့်၍ မရနိုင်တော့ပါ။</i>", { parse_mode: "HTML" });
          }
        } else {
          await sendMessage(env.BOT_TOKEN, chatId, "❌ PIN မှားနေပါတယ်။ ပြန်စမ်းကြည့်ပါ (သို့) /cancel လို့ ရိုက်ထည့်ပါ။");
        }
        return;
      }

      if (stateRow.action === 'setting_pin') {
        if (text.length >= 4) {
          await env.DB.prepare("UPDATE files SET pin = ? WHERE file_id = ?").bind(text, stateRow.file_key).run();
          await sendMessage(env.BOT_TOKEN, chatId, `✅ PIN နံပါတ်ကို <code>${text}</code> အဖြစ် သတ်မှတ်ပြီးပါပြီ。\n🔗 အခု Link ကို နှိပ်သူတိုင်း ဒီ PIN မှန်အောင် ထည့်နိုင်မှသာ ဖိုင်ကို မြင်ရပါတော့မယ်။`, { parse_mode: "HTML", reply_markup: defaultKeyboard });
          await env.DB.prepare('DELETE FROM states WHERE chat_id = ?').bind(chatId).run();
        } else {
          await sendMessage(env.BOT_TOKEN, chatId, "❌ PIN နံပါတ်က အနည်းဆုံး ဂဏန်း ၄ လုံး ရှိရပါမယ်။ ပြန်စမ်းကြည့်ပါ (သို့) /cancel လို့ ရိုက်ထည့်ပါ။");
        }
        return;
      }

      if (stateRow.action === 'setting_custom_link') {
        const newLink = text.trim();
        if (!/^[a-zA-Z0-9_]+$/.test(newLink)) {
          await sendMessage(env.BOT_TOKEN, chatId, "❌ Custom Link မှာ အင်္ဂလိပ်စာလုံး၊ ဂဏန်း နဲ့ Underscore (_) တွေပဲ သုံးခွင့်ရှိပါတယ်။ ပြန်စမ်းကြည့်ပါ (သို့) /cancel နှိပ်ပါ။");
          return;
        }
        const existingByLink = await env.DB.prepare("SELECT file_id FROM files WHERE custom_link = ?").bind(newLink).first();
        const existingById = await env.DB.prepare("SELECT file_id FROM files WHERE file_id = ?").bind(newLink).first();
        if (existingByLink || existingById) {
          await sendMessage(env.BOT_TOKEN, chatId, "❌ ဒီ Custom Link နာမည်ကို တခြားသူ ယူထားပြီးပါပြီ။ နာမည်ပြောင်းပေးပါ (သို့) /cancel နှိပ်ပါ။");
          return;
        }
        await env.DB.prepare("UPDATE files SET custom_link = ? WHERE file_id = ?").bind(newLink, stateRow.file_key).run();
        await env.DB.prepare('DELETE FROM states WHERE chat_id = ?').bind(chatId).run();

        const link = `https://t.me/${botUsername}?start=${newLink}`;
        await sendMessage(env.BOT_TOKEN, chatId, `✅ <b>Custom Link အောင်မြင်စွာ ပြောင်းလဲပြီးပါပြီ!</b>\n\n🔗 <b>Link အသစ်:</b>\n${link}`, { parse_mode: "HTML", reply_markup: defaultKeyboard, disable_web_page_preview: true });
        return;
      }
    }
  }

  if (text.startsWith('/del_')) {
    const fileKey = text.substring(5);
    const fileRow = await findFile(env.DB, fileKey);

    if (!fileRow) {
      await sendMessage(env.BOT_TOKEN, chatId, "❌ ဖိုင်ကို ရှာမတွေ့ပါဘူး (သို့) ပျက်သွားပါပြီ။");
      return;
    }
    if (fileRow.owner_id !== chatId) {
      await sendMessage(env.BOT_TOKEN, chatId, "❌ သင်ဟာ ဒီဖိုင်ရဲ့ ပိုင်ရှင် မဟုတ်ပါဘူး။");
      return;
    }
    await env.DB.prepare("DELETE FROM files WHERE file_id = ?").bind(fileRow.file_id).run();
    await sendMessage(env.BOT_TOKEN, chatId, `🗑 <b>ဖိုင်ကို ဖျက်လိုက်ပါပြီ</b>\n\nID: <code>#${getShareKey(fileRow)}</code> ကို သင့်ရဲ့ Storage ထဲကနေ အပြီးတိုင် ဖျက်ပစ်လိုက်ပါပြီ။`, { parse_mode: "HTML" });
    return;
  }

  if (text.startsWith('/start')) {
    const parts = text.split(' ');
    if (parts.length > 1) {
      const fileKey = parts[1];
      const fileRow = await findFile(env.DB, fileKey);

      if (!fileRow) {
        await sendMessage(env.BOT_TOKEN, chatId, "❌ ဖိုင်ကို ရှာမတွေ့ပါဘူး (သို့) ပိုင်ရှင်က ဖျက်ပစ်လိုက်ပါပြီ။");
        return;
      }

      if (fileRow.pin) {
        await env.DB.prepare("INSERT OR REPLACE INTO states (chat_id, action, file_key, created_at) VALUES (?, 'awaiting_pin', ?, datetime('now'))").bind(chatId, fileRow.file_id).run();
        await sendMessage(env.BOT_TOKEN, chatId, "🔒 ဒီဖိုင်ကို လုံခြုံရေးအရ သော့ခတ်ထားပါတယ်။ ကြည့်ရှုရန် PIN နံပါတ် ရိုက်ထည့်ပါ:");
      } else {
        const sent = await deliverFile(env, chatId, fileRow);
        if (!sent) {
          await sendMessage(env.BOT_TOKEN, chatId, "❌ ဖိုင်ကို ပြန်လည်ရယူရာတွင် အခက်အခဲရှိနေပါသည်။");
          return;
        }

        if (fileRow.burn) {
          await env.DB.prepare("DELETE FROM files WHERE file_id = ?").bind(fileRow.file_id).run();
          await sendMessage(env.BOT_TOKEN, chatId, "🔥 <i>ဒီဖိုင်ဟာ တစ်ခါကြည့် (Burn) အဖြစ် သတ်မှတ်ထားလို့ အခု ဖွင့်ကြည့်ပြီးတာနဲ့ အလိုအလျောက် အပြီးတိုင် ဖျက်ပစ်လိုက်ပါပြီ။ နောက်တစ်ကြိမ် ပြန်ကြည့်၍ မရနိုင်တော့ပါ။</i>", { parse_mode: "HTML" });
        }
      }
      return;
    }

    await sendMessage(env.BOT_TOKEN, chatId, "PIN BOX - Private & Secure Storage\n\nဖုန်းထဲမှာထားရင် အန္တရာယ်ရှိနိုင်တဲ့ အရေးကြီးဖိုင်တွေအတွက် PIN BOX ရှိပါတယ်။\nဒေတာအားလုံးကို အပြင် Server တွေမှာ လုံးဝမသိမ်းဘဲ၊ Telegram ရဲ့ လုံခြုံတဲ့ Cloud Storage ကိုပဲ အပြည့်အဝ အသုံးချထားပါတယ်။\n\nCore Features:\n- PIN Protect (စကားဝှက်ဖြင့် ကာကွယ်ခြင်း)\n- Burn Mode (တစ်ကြိမ်သာ ကြည့်ရှုခွင့်ပေးခြင်း)\n- Anti-Leak (Save & Forward တားဆီးခြင်း)\n\nသင်သိမ်းဆည်းလိုသော Media သို့မဟုတ် ဖိုင်များကို ယခုပဲ ပေးပို့ပါ။", { reply_markup: defaultKeyboard });
    return;
  }

  if (text === '/myfiles' || text === '📂 ငါ့ရဲ့ဖိုင်များ (My Files)') {
    const { results } = await env.DB.prepare("SELECT file_id, custom_link FROM files WHERE owner_id = ? ORDER BY rowid DESC LIMIT 50").bind(chatId).all();
    if (results.length === 0) {
      await sendMessage(env.BOT_TOKEN, chatId, "အခုထိ ဘာဖိုင်မှ မသိမ်းထားရသေးပါဘူး။ ဖိုင်တစ်ခုခု အရင်ပို့ကြည့်ပါ။");
      return;
    }
    let listText = "📂 <b>သင် သိမ်းဆည်းထားသော ဖိုင်များ:</b>\n\n";
    results.forEach((row, i) => {
      const displayKey = row.custom_link || row.file_id;
      const link = `https://t.me/${botUsername}?start=${displayKey}`;
      listText += `${i+1}. <code>#${displayKey}</code>\n🔗 <a href="${link}">ကြည့်ရန်</a> | 🗑 ဖျက်ရန်: /del_${row.file_id}\n\n`;
    });
    await sendMessage(env.BOT_TOKEN, chatId, listText, { parse_mode: "HTML", disable_web_page_preview: true });
    return;
  }

  if (text === '/help' || text === 'ℹ️ အသုံးပြုနည်း (Help)') {
    const helpMsg = `🌟 <b>PIN BOX အသုံးပြုနည်း လမ်းညွှန်</b>\n\n<b>၁။ 📤 ဖိုင်သိမ်းရန်</b>\nသိမ်းဆည်းလိုသော ဖိုင်၊ ဓာတ်ပုံ သို့မဟုတ် ဗီဒီယိုကို ဤ Bot သို့ တိုက်ရိုက် ပေးပို့ပါ။\n\n<b>၂။ 🔗 Link ယူရန်</b>\nဖိုင်ရောက်ရှိသွားပါက ပြန်လည်ကြည့်ရှုနိုင်မည့် 🔗 <b>Secure Link</b> တစ်ခုကို ချက်ချင်း ပြန်လည် ပေးပို့ပါမည်။\n\n<b>၃။ 🔒 လုံခြုံရေး (PIN Code)</b>\nမိမိ၏ ဖိုင်ကို အခြားသူများ မကြည့်စေချင်ပါက <code>[ 🔒 PIN နံပါတ်ခံမည် ]</code> ခလုတ်ကို နှိပ်၍ သော့ခတ်ထားနိုင်ပါသည်။\n\n<b>၄။ 🔥 တစ်ခါကြည့် (Burn After Read)</b>\n<code>[ 🔥 တစ်ခါကြည့် (Burn) ]</code> ကို ဖွင့်ထားပါက၊ Link အား ဖွင့်ကြည့်ပြီးသည်နှင့် ဖိုင်မှာ <b>အလိုအလျောက် အပြီးတိုင် ပျက်သွားပါမည်</b>။\n\n<b>၅။ 🗑 ဖိုင်ဖျက်ရန်</b>\nမလိုအပ်တော့သော ဖိုင်များကို <code>[ 🗑 ဖိုင်ကိုဖျက်မည် ]</code> နှိပ်၍ ဖျက်ပစ်နိုင်ပါသည်။`;
    await sendMessage(env.BOT_TOKEN, chatId, helpMsg, { parse_mode: "HTML" });
    return;
  }

  const fileInfo = extractFileInfo(message);
  if (!fileInfo) {
    await sendMessage(env.BOT_TOKEN, chatId, "💡 ကျေးဇူးပြု၍ သိမ်းဆည်းလိုသော ဖိုင်၊ ဓာတ်ပုံ၊ ဗီဒီယို သို့မဟုတ် Document များကိုသာ ပေးပို့ပါ။");
    return;
  }

  const uuid = crypto.randomUUID().replace(/-/g, '').substring(0, 12);
  const fileKey = `file_${uuid}`;

  await env.DB.prepare(
    "INSERT INTO files (file_id, channel_msg_id, backup_msg_id, pin, burn, anti_leak, owner_id, custom_link, telegram_file_id, media_type, caption) VALUES (?, NULL, NULL, NULL, 0, 0, ?, NULL, ?, ?, ?)"
  ).bind(fileKey, chatId, fileInfo.fileId, fileInfo.mediaType, fileInfo.caption).run();

  const link = `https://t.me/${botUsername}?start=${fileKey}`;
  const replyText = `✅ <b>ဖိုင်ကို လုံခြုံစွာ သိမ်းဆည်းပေးလိုက်ပါပြီ!</b>\n\nဖိုင် ID: <code>#${fileKey}</code>\n🔗 <b>ဒီဖိုင်ကို ပြန်ကြည့်ရန် Link:</b>\n${link}\n\n<i>(အောက်ပါ ခလုတ်များကို နှိပ်၍ ဖိုင်ကို စီမံနိုင်ပါသည်)</i>`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "📝 Custom Link ပြောင်းမည်", callback_data: `custom_${fileKey}` }],
      [{ text: "🔒 PIN နံပါတ်ခံမည်", callback_data: `pin_${fileKey}` }],
      [{ text: "🔥 တစ်ခါကြည့် (Burn)", callback_data: `burn_${fileKey}` }, { text: "🛡 Anti-Leak", callback_data: `leak_${fileKey}` }],
      [{ text: "🗑 ဖိုင်ကိုဖျက်မည်", callback_data: `del_${fileKey}` }]
    ]
  };
  await sendMessage(env.BOT_TOKEN, chatId, replyText, { parse_mode: "HTML", reply_markup: keyboard, disable_web_page_preview: true });
}

async function handleCallbackQuery(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const action = data.split('_')[0];
  const fileKey = data.substring(action.length + 1);
  const fileRow = await env.DB.prepare("SELECT * FROM files WHERE file_id = ?").bind(fileKey).first();
  if (!fileRow) {
      await answerCallbackQuery(env.BOT_TOKEN, query.id, "❌ ဖိုင်ကို ရှာမတွေ့ပါဘူး။");
      return;
  }
  if (fileRow.owner_id !== chatId) {
      await answerCallbackQuery(env.BOT_TOKEN, query.id, "❌ သင့်ဖိုင်မဟုတ်ပါ။");
      return;
  }

  await env.DB.prepare('DELETE FROM states WHERE chat_id = ?').bind(chatId).run();

  if (action === 'pin') {
    await answerCallbackQuery(env.BOT_TOKEN, query.id);
    const pinKeyboard = {
      inline_keyboard: [
        [{ text: "🎲 Random PIN ထုတ်မည်", callback_data: `rpin_${fileKey}` }],
        [{ text: "✏️ ကိုယ်တိုင်ထည့်မည်", callback_data: `cpin_${fileKey}` }]
      ]
    };
    await sendMessage(env.BOT_TOKEN, chatId, "🔒 PIN နံပါတ် သတ်မှတ်ရန် နည်းလမ်း ရွေးပါ:", { reply_markup: pinKeyboard });
  } else if (action === 'rpin') {
    const randomPin = String(Math.floor(1000 + Math.random() * 9000));
    await env.DB.prepare("UPDATE files SET pin = ? WHERE file_id = ?").bind(randomPin, fileKey).run();
    await answerCallbackQuery(env.BOT_TOKEN, query.id, "🔒 Random PIN သတ်မှတ်ပြီးပါပြီ!");
    await sendMessage(env.BOT_TOKEN, chatId, `🔒 <b>PIN နံပါတ် သတ်မှတ်ပြီးပါပြီ!</b>\n\nသင့်ဖိုင်ရဲ့ PIN: <code>${randomPin}</code>\n\n⚠️ ဒီ PIN ကို မှတ်ထားပါ။ Link နှိပ်သူတိုင်း ဒီ PIN ထည့်မှသာ ဖိုင်ကို ကြည့်ရှုနိုင်ပါတော့မယ်။`, { parse_mode: "HTML" });
  } else if (action === 'cpin') {
    await env.DB.prepare("INSERT OR REPLACE INTO states (chat_id, action, file_key, created_at) VALUES (?, 'setting_pin', ?, datetime('now'))").bind(chatId, fileKey).run();
    await answerCallbackQuery(env.BOT_TOKEN, query.id);
    await sendMessage(env.BOT_TOKEN, chatId, `ဒီဖိုင်အတွက် သတ်မှတ်ချင်တဲ့ PIN ဂဏန်းကို အခု ရိုက်ထည့်ပေးပါ (အနည်းဆုံး ၄ လုံး)။\n\nမလုပ်တော့ရင် /cancel ကို နှိပ်ပါ။`, { parse_mode: "HTML" });
  } else if (action === 'custom') {
    await env.DB.prepare("INSERT OR REPLACE INTO states (chat_id, action, file_key, created_at) VALUES (?, 'setting_custom_link', ?, datetime('now'))").bind(chatId, fileKey).run();
    await answerCallbackQuery(env.BOT_TOKEN, query.id);
    await sendMessage(env.BOT_TOKEN, chatId, `ဒီဖိုင်အတွက် သတ်မှတ်ချင်တဲ့ Custom Link နာမည်ကို အခု ရိုက်ထည့်ပေးပါ။\n(ဥပမာ - my_secret_file) သို့မဟုတ် မလုပ်တော့ရင် /cancel ကို နှိပ်ပါ။`, { parse_mode: "HTML" });
  } else if (action === 'burn' || action === 'leak') {
    let burn = fileRow.burn;
    let anti_leak = fileRow.anti_leak;

    if (action === 'burn') {
      burn = burn ? 0 : 1;
      await answerCallbackQuery(env.BOT_TOKEN, query.id, burn ? "🔥 Burn Mode ဖွင့်လိုက်ပါပြီ!" : "✅ Burn Mode ပိတ်လိုက်ပါပြီ!");
    } else {
      anti_leak = anti_leak ? 0 : 1;
      await answerCallbackQuery(env.BOT_TOKEN, query.id, anti_leak ? "🛡 Anti-Leak ဖွင့်လိုက်ပါပြီ! (Forward/Save လုပ်ခွင့်မရှိ)" : "✅ Anti-Leak ပိတ်လိုက်ပါပြီ!");
    }

    await env.DB.prepare("UPDATE files SET burn = ?, anti_leak = ? WHERE file_id = ?").bind(burn, anti_leak, fileKey).run();

    const burnText = burn ? "🔥 Burn (ဖွင့်ထားသည်)" : "🔥 တစ်ခါကြည့် (Burn)";
    const leakText = anti_leak ? "🛡 Anti-Leak (ဖွင့်ထားသည်)" : "🛡 Anti-Leak";
    const keyboard = {
      inline_keyboard: [
        [{ text: "📝 Custom Link ပြောင်းမည်", callback_data: `custom_${fileKey}` }],
        [{ text: "🔒 PIN နံပါတ်ခံမည်", callback_data: `pin_${fileKey}` }],
        [{ text: burnText, callback_data: `burn_${fileKey}` }, { text: leakText, callback_data: `leak_${fileKey}` }],
        [{ text: "🗑 ဖိုင်ကိုဖျက်မည်", callback_data: `del_${fileKey}` }]
      ]
    };
    await editMessageReplyMarkup(env.BOT_TOKEN, chatId, messageId, keyboard);
  } else if (action === 'del') {
    await env.DB.prepare("DELETE FROM files WHERE file_id = ?").bind(fileKey).run();
    await answerCallbackQuery(env.BOT_TOKEN, query.id, "ဖျက်လိုက်ပါပြီ။");
    await editMessageText(env.BOT_TOKEN, chatId, messageId, `🗑 <b>ဖိုင်ကို ဖျက်လိုက်ပါပြီ</b>`, { parse_mode: "HTML" });
  }
}

async function sendMessage(token, chatId, text, options = {}) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, ...options })
  });
}
async function copyMessage(token, toChatId, fromChatId, messageId, options = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId, ...options })
  });
  return await res.json();
}
async function answerCallbackQuery(token, queryId, text = null) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: queryId, text: text })
  });
}
async function editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup })
  });
}
async function editMessageText(token, chatId, messageId, text, options = {}) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text, ...options })
  });
}
async function getMe(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  return (await res.json()).result;
}
