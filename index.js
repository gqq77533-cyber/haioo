const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, makeInMemoryStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// إنشاء مجلدات التخزين إذا لم تكن موجودة
if (!fs.existsSync('auth_info_baileys')) {
    fs.mkdirSync('auth_info_baileys', { recursive: true });
}

const app = express();
const PORT = process.env.PORT || 3000;

// إعداد قاعدة البيانات
const db = new sqlite3.Database('users.db');
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            phone_number TEXT,
            attempts INTEGER DEFAULT 0,
            max_attempts INTEGER DEFAULT 1,
            last_attempt TEXT
        )
    `);
});

// تحويل دوال SQLite إلى Promises
const dbRun = promisify(db.run).bind(db);
const dbGet = promisify(db.get).bind(db);
const dbAll = promisify(db.all).bind(db);

// إعدادات الادمن
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || "249123456789";

// تخزين بيانات المستخدمين المؤقتة
const userSessions = new Map();

// إعداد خادم Express
app.use(express.json());
app.get('/', (req, res) => {
    res.send('✅ بوت واتساب السوداني يعمل بنجاح');
});

app.listen(PORT, () => {
    console.log(`🚀 الخادم يعمل على المنفذ ${PORT}`);
});

// دوال قاعدة البيانات
async function getUserAttempts(userId) {
    try {
        const user = await dbGet('SELECT attempts, max_attempts FROM users WHERE user_id = ?', [userId]);
        if (user) {
            return { attempts: user.attempts, maxAttempts: user.max_attempts };
        } else {
            await dbRun('INSERT INTO users (user_id, attempts, max_attempts) VALUES (?, 0, 1)', [userId]);
            return { attempts: 0, maxAttempts: 1 };
        }
    } catch (error) {
        console.error('Error getting user attempts:', error);
        return { attempts: 0, maxAttempts: 1 };
    }
}

async function incrementAttempts(userId, phoneNumber) {
    try {
        const user = await dbGet('SELECT attempts FROM users WHERE user_id = ?', [userId]);
        if (user) {
            await dbRun('UPDATE users SET attempts = attempts + 1, phone_number = ?, last_attempt = datetime("now") WHERE user_id = ?', 
                        [phoneNumber, userId]);
        } else {
            await dbRun('INSERT INTO users (user_id, phone_number, attempts, max_attempts, last_attempt) VALUES (?, ?, 1, 1, datetime("now"))', 
                        [userId, phoneNumber]);
        }
    } catch (error) {
        console.error('Error incrementing attempts:', error);
    }
}

async function setUserLimit(userId, limit) {
    try {
        await dbRun('UPDATE users SET max_attempts = ? WHERE user_id = ?', [limit, userId]);
    } catch (error) {
        console.error('Error setting user limit:', error);
    }
}

async function canMakeAttempt(userId) {
    const { attempts, maxAttempts } = await getUserAttempts(userId);
    return attempts < maxAttempts;
}

async function getStats() {
    try {
        const totalUsers = await dbGet('SELECT COUNT(*) as count FROM users');
        const totalAttempts = await dbGet('SELECT SUM(attempts) as total FROM users');
        const activeUsers = await dbAll('SELECT user_id, phone_number, attempts, max_attempts FROM users WHERE attempts > 0 ORDER BY attempts DESC LIMIT 10');
        
        return {
            totalUsers: totalUsers.count,
            totalAttempts: totalAttempts.total || 0,
            activeUsers: activeUsers
        };
    } catch (error) {
        console.error('Error getting stats:', error);
        return { totalUsers: 0, totalAttempts: 0, activeUsers: [] };
    }
}

// دوال API السوداني
async function sendOtpRequest(phoneNumber) {
    const url = "https://mapp.sudani.sd/prod/sc-onboarding/api/customer/generate-otp";

    const payload = {
        "msisdn": phoneNumber,
        "primaryMsisdn": phoneNumber,
        "email": "",
        "method": "SMS",
        "useCase": "ONBOARDING"
    };

    const headers = {
        'User-Agent': "Dart/3.7 (dart:io)",
        'Accept-Encoding': "gzip",
        'Content-Type': "application/json",
        'is-b2b': "",
        'device-id': "pond_Redmi_pond_2409BRN2CA_Xiaomi_mt6768_AP3A.240905.015.A2",
        'primary-msisdn': phoneNumber,
        'tenant': "tec_sudatel",
        'subscriber-type': "",
        'servicetype': "",
        'lastlogin': "",
        'location': "",
        'user-id': "",
        'transaction-token': "abc",
        'sim-category': "",
        'msisdn': phoneNumber,
        'primary-offer-id': "",
        'milestoneidentifier': "",
        'current-loyalty-points': "0",
        'primary-offer-name': "",
        'chosen-reward': "",
        'price': "0",
        'related-primary-mdn': "",
        'sim-type': "",
        'servicecode': "",
        'payment-method': "bok",
        'channel': "sc_app",
        'rewardpoints': "",
        'current-balance': "0.0",
        'x-auth-selfcare-key': "",
        'price-plan': "",
        'rewardsreport': "",
        'providerid': "",
        'sim-activation-time': "",
        'termsandconditions': "Yes",
        'platform': "android",
        'paymentmethod': "bok",
        'typeoftransaction': "",
        'language': "en",
        'fcmtoken': "",
        'reward-types': "",
        'milestone': "",
        'sim-preference': "Primary"
    };

    try {
        const response = await axios.post(url, payload, { headers, timeout: 10000 });
        if (response.status === 200) {
            const responseData = response.data;
            return responseData.responseCode === "200";
        }
        return false;
    } catch (error) {
        console.error('Error sending OTP:', error);
        return false;
    }
}

async function verifyOtpAndClaimReward(phoneNumber, otpCode) {
    try {
        // الخطوة 1: التحقق من OTP
        const onboardingUrl = "https://mapp.sudani.sd/prod/sc-onboarding/api/customer/onboarding";
        
        const onboardingPayload = {
            "msisdn": phoneNumber,
            "primaryMsisdn": phoneNumber,
            "otp": otpCode,
            "useCase": "ONBOARDING"
        };

        const headers = {
            'User-Agent': "Dart/3.7 (dart:io)",
            'Accept-Encoding': "gzip",
            'Content-Type': "application/json",
            'is-b2b': "",
            'device-id': "pond_Redmi_pond_2409BRN2CA_Xiaomi_mt6768_AP3A.240905.015.A2",
            'primary-msisdn': phoneNumber,
            'tenant': "tec_sudatel",
            'subscriber-type': "",
            'servicetype': "",
            'lastlogin': "",
            'location': "",
            'user-id': "",
            'transaction-token': "abc",
            'sim-category': "",
            'msisdn': phoneNumber,
            'primary-offer-id': "",
            'milestoneidentifier': "",
            'current-loyalty-points': "0",
            'primary-offer-name': "",
            'chosen-reward': "",
            'price': "0",
            'related-primary-mdn': "",
            'sim-type': "",
            'servicecode': "",
            'payment-method': "bok",
            'channel': "sc_app",
            'rewardpoints': "",
            'current-balance': "0.0",
            'x-auth-selfcare-key': "",
            'price-plan': "",
            'rewardsreport': "",
            'providerid': "",
            'sim-activation-time': "",
            'termsandconditions': "Yes",
            'platform': "android",
            'paymentmethod': "bok",
            'typeoftransaction': "",
            'language': "en",
            'fcmtoken': "",
            'reward-types': "",
            'milestone': "",
            'sim-preference': "Primary"
        };

        const onboardingResponse = await axios.post(onboardingUrl, onboardingPayload, { headers, timeout: 10000 });
        
        if (onboardingResponse.status !== 200) {
            return "❌ فشل في الاتصال بالخادم";
        }

        const onboardingData = onboardingResponse.data;
        
        if (onboardingData.responseCode !== "200" || !onboardingData.data) {
            return "❌ كود التحقق غير صحيح أو انتهت صلاحيته";
        }

        // استخراج البيانات المطلوبة
        const token = onboardingData.data.token;
        const customerId = onboardingData.data.customerId;
        const primaryOfferId = onboardingData.data.primaryOfferId;
        const primaryOfferName = onboardingData.data.primaryOfferName;
        const creationTime = onboardingData.data.creationTime;

        // الخطوة 2: المطالبة بالمكافأة
        const currentTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
        
        const rewardUrl = "https://mapp.sudani.sd/prod/gamification-service/api/reward/claim";
        
        const rewardPayload = {
            "Current-loyalty-points": "20.0",
            "milestone": "NO",
            "milestoneIdentifier": "1"
        };

        const rewardHeaders = {
            ...headers,
            'is-b2b': "false",
            'subscriber-type': "Prepaid",
            'lastlogin': currentTime + ".000",
            'location': "SD",
            'user-id': customerId,
            'primary-offer-id': primaryOfferId,
            'current-loyalty-points': "20.0",
            'primary-offer-name': primaryOfferName,
            'related-primary-mdn': phoneNumber,
            'sim-type': "Prepaid",
            'current-balance': "0.00",
            'x-auth-selfcare-key': token,
            'price-plan': primaryOfferName,
            'sim-activation-time': creationTime
        };

        const rewardResponse = await axios.post(rewardUrl, rewardPayload, { headers: rewardHeaders, timeout: 10000 });
        
        if (rewardResponse.status === 200) {
            const rewardData = rewardResponse.data;
            
            if (rewardData.responseCode === "200") {
                if (rewardData.data?.message === "Reward already claimed") {
                    return "✅ تم الحصول على المكافأة مسبقاً لهذا الرقم";
                } else {
                    return "🎉 تم الحصول على المكافأة بنجاح!";
                }
            } else {
                return "❌ فشل في الحصول على المكافأة";
            }
        } else {
            return "❌ فشل في الاتصال لطلب المكافأة";
        }

    } catch (error) {
        console.error('Error claiming reward:', error);
        return "❌ حدث خطأ أثناء المعالجة";
    }
}

// إعداد بوت واتساب
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const store = makeInMemoryStore({});
        
        const sock = makeWASocket({
            printQRInTerminal: true,
            auth: state,
            logger: {
                level: 'silent'
            }
        });

        store.bind(sock.ev);

        // توليد QR code
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrcode.generate(qr, { small: true });
                console.log('📱 قم بمسح QR code للاتصال بواتساب');
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
                console.log('❌ تم فصل الاتصال، إعادة الاتصال...');
                if (shouldReconnect) {
                    connectToWhatsApp();
                }
            } else if (connection === 'open') {
                console.log('✅ تم الاتصال بواتساب بنجاح');
            }
        });

        // حفظ بيانات الجلسة
        sock.ev.on('creds.update', saveCreds);

        // معالجة الرسائل
        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            
            if (!msg.message || msg.key.fromMe) return;

            const sender = msg.key.remoteJid;
            const messageText = msg.message.conversation || 
                               msg.message.extendedTextMessage?.text || '';

            if (!messageText) return;

            const userNumber = sender.split('@')[0];
            const { attempts, maxAttempts } = await getUserAttempts(sender);

            // أوامر البوت
            if (messageText === '.start' || messageText === 'بدء' || messageText === 'start') {
                const welcomeMessage = `🎉 *مرحباً بك في بوت السوداني* 🎉

📱 *الرجاء إدخال رقم هاتفك السوداني:*
- يجب أن يكون الرقم مكون من 9 أرقام فقط
- يجب أن يبدأ بالرقم 1
- مثال: 123456789

📊 *المحاولات المتاحة:* ${attempts}/${maxAttempts}

⚠️ *ملاحظة:* هذا البوت لأغراض تعليمية فقط

👨‍💻 *المطور:* Satan
📧 *التواصل:* https://t.me/YT_NT`;

                await sock.sendMessage(sender, { text: welcomeMessage });
                return;
            }

            // أوامر الادمن
            if (userNumber === ADMIN_NUMBER.replace('+', '')) {
                if (messageText.startsWith('.limit')) {
                    const parts = messageText.split(' ');
                    if (parts.length === 3) {
                        const targetUser = parts[1] + '@s.whatsapp.net';
                        const limit = parseInt(parts[2]);
                        
                        await setUserLimit(targetUser, limit);
                        await sock.sendMessage(sender, { text: `✅ تم تعين الحد الأقصى للمحاولات للمستخدم ${parts[1]} إلى ${limit}` });
                    } else {
                        await sock.sendMessage(sender, { text: '❌ استخدام خاطئ\nاستخدم: .limit [رقم المستخدم] [عدد المحاولات]' });
                    }
                    return;
                }

                if (messageText === '.stats') {
                    const stats = await getStats();
                    let statsText = `📊 *إحصائيات البوت:*

👥 إجمالي المستخدمين: ${stats.totalUsers}
🔄 إجمالي المحاولات: ${stats.totalAttempts}

📋 *آخر 10 مستخدمين نشطين:*`;

                    stats.activeUsers.forEach(user => {
                        statsText += `\n- رقم: ${user.phone_number} | محاولات: ${user.attempts}/${user.max_attempts}`;
                    });

                    await sock.sendMessage(sender, { text: statsText });
                    return;
                }
            }

            // التحقق من رقم الهاتف
            if (/^1\d{8}$/.test(messageText)) {
                const phoneNumber = messageText;

                if (!await canMakeAttempt(sender)) {
                    await sock.sendMessage(sender, { text: `❌ لقد استنفذت جميع محاولاتك (${attempts}/${maxAttempts})` });
                    return;
                }

                userSessions.set(sender, { phone: phoneNumber, step: 'waiting_otp' });
                
                await sock.sendMessage(sender, { text: "⏳ جاري إرسال رمز التحقق..." });
                
                if (await sendOtpRequest(phoneNumber)) {
                    await sock.sendMessage(sender, { text: "✅ تم إرسال رمز التحقق بنجاح\n\n📝 الرجاء إدخال الكود المكون من 4 أرقام:" });
                } else {
                    await sock.sendMessage(sender, { text: "❌ فشل في إرسال رمز التحقق، الرجاء المحاولة لاحقاً" });
                    userSessions.delete(sender);
                }
                return;
            }

            // التحقق من كود OTP
            if (/^\d{4}$/.test(messageText) && userSessions.has(sender)) {
                const userSession = userSessions.get(sender);
                
                if (userSession.step === 'waiting_otp') {
                    const otpCode = messageText;
                    const phoneNumber = userSession.phone;

                    await sock.sendMessage(sender, { text: "⏳ جاري التحقق من الكود والحصول على المكافأة..." });
                    
                    const result = await verifyOtpAndClaimReward(phoneNumber, otpCode);
                    await sock.sendMessage(sender, { text: result });
                    
                    await incrementAttempts(sender, phoneNumber);
                    userSessions.delete(sender);
                    
                    // إرسال تحديث المحاولات
                    const newAttempts = await getUserAttempts(sender);
                    await sock.sendMessage(sender, { text: `📊 المحاولات المتبقية: ${newAttempts.attempts}/${newAttempts.maxAttempts}` });
                    
                    return;
                }
            }

            // رسالة افتراضية
            if (!userSessions.has(sender)) {
                await sock.sendMessage(sender, { 
                    text: `📱 الرجاء إدخال رقم هاتف سوداني صحيح (9 أرقام تبدأ بـ 1)\n\n📊 المحاولات المتاحة: ${attempts}/${maxAttempts}\n\nاكتب "بدء" لإعادة التشغيل` 
                });
            } else if (userSessions.get(sender).step === 'waiting_otp') {
                await sock.sendMessage(sender, { text: "📝 الرجاء إدخال كود التحقق المكون من 4 أرقام فقط" });
            }
        });

    } catch (error) {
        console.error('❌ خطأ في الاتصال:', error);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// تشغيل البوت
connectToWhatsApp();