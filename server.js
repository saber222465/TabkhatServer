// server.js - سيرفر طبخة اليوم مع MongoDB
const express  = require('express');
const mongoose = require('mongoose');
const app      = express();
app.use(express.json());

const OPENAI_KEY  = process.env.OPENAI_KEY;
const YOUTUBE_KEY = process.env.YOUTUBE_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

const POOL_SIZE     = 50;
const REFILL_AT     = 10;
const CUISINE_TYPES = ['سورية', 'مصرية', 'لبنانية', 'خليجية', 'مغربية', 'تركية', 'إيطالية', 'إسبانية'];

// ─── MongoDB Schema ────────────────────────────────────────
const mealSchema = new mongoose.Schema({
  name:        { type: String, unique: true },
  emoji:       String,
  desc:        String,
  difficulty:  String,
  calories:    String,
  protein:     String,
  carbs:       String,
  cuisine:     String,
  ingredients: Array,
  steps:       Array,
  tips:        String,
  time:        String,
  serves:      String,
  search:      String,
  videoId:     String,
  thumb:       String,
  used:        { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now },
});

const Meal = mongoose.model('Meal', mealSchema);

// ─── اتصال MongoDB ────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('✅ متصل بـ MongoDB');
    checkAndRefill();
  })
  .catch(err => console.error('❌ خطأ MongoDB:', err.message));

let isRefilling = false;
let totalSaved  = 0;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─── جلب فيديو يوتيوب ─────────────────────────────────────
async function fetchYoutubeVideo(query) {
  if (!YOUTUBE_KEY) return null;
  try {
    const res  = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=1&videoDuration=medium&key=${YOUTUBE_KEY}`
    );
    const data = await res.json();
    const item = data.items?.[0];
    if (item) return {
      videoId: item.id?.videoId,
      thumb:   item.snippet?.thumbnails?.high?.url,
    };
  } catch (_) {}
  return null;
}

// ─── جلب طبخة من ChatGPT ──────────────────────────────────
async function fetchMealFromAI(cuisine = '') {
  const cuisineText = cuisine || CUISINE_TYPES[Math.floor(Math.random() * CUISINE_TYPES.length)];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'أنت طاهٍ محترف. أجب دائماً بـ JSON فقط بدون أي نص إضافي.' },
        { role: 'user', content: `اقترح وصفة ${cuisineText} أصيلة عشوائية ومفصلة. أجب بـ JSON فقط:\n{"name":"اسم الطبخة","emoji":"إيموجي","desc":"وصف شهي","difficulty":"سهل أو متوسط أو صعب","calories":"السعرات","protein":"البروتين بالغرام","carbs":"الكربوهيدرات بالغرام","cuisine":"${cuisineText}","ingredients":[{"item":"المكون","amount":"الكمية الدقيقة"},{"item":"مكون","amount":"كمية"},{"item":"مكون","amount":"كمية"},{"item":"مكون","amount":"كمية"},{"item":"مكون","amount":"كمية"},{"item":"مكون","amount":"كمية"},{"item":"البهارات","amount":"كل بهارة على حدى"}],"steps":["الخطوة الأولى مفصلة","الخطوة الثانية","الخطوة الثالثة","الخطوة الرابعة","الخطوة الخامسة","الخطوة السادسة"],"tips":"نصيحة مفيدة","time":"وقت التحضير","serves":"عدد الأشخاص","search":"اسم الطبخة recipe youtube"}` }
      ],
      temperature: 1.0,
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const txt   = data.choices?.[0]?.message?.content || '';
  const match = txt.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('فشل تحليل الرد');

  const meal = JSON.parse(match[0]);

  // أضف الفيديو
  const video = await fetchYoutubeVideo(meal.search || meal.name);
  if (video) {
    meal.videoId = video.videoId;
    meal.thumb   = video.thumb;
  }

  return meal;
}

// ─── تعبئة المخزن ─────────────────────────────────────────
async function checkAndRefill() {
  if (isRefilling) return;
  const count = await Meal.countDocuments({ used: false });
  console.log(`📊 الطبخات المتاحة: ${count}`);
  if (count < REFILL_AT) {
    refillPool(POOL_SIZE - count);
  }
}

async function refillPool(count = 10) {
  if (isRefilling) return;
  isRefilling = true;
  console.log(`🔄 جاري تعبئة ${count} طبخة...`);

  const promises = Array.from({ length: count }, (_, i) => {
    const cuisine = CUISINE_TYPES[i % CUISINE_TYPES.length];
    return fetchMealFromAI(cuisine)
      .then(async meal => {
        try {
          await Meal.create(meal);
          return meal;
        } catch (_) { return null; } // تجاهل التكرار
      })
      .catch(err => {
        console.error('خطأ:', err.message);
        return null;
      });
  });

  await Promise.all(promises);
  const total = await Meal.countDocuments({ used: false });
  isRefilling = false;
  console.log(`✅ المخزن الآن: ${total} طبخة`);
}

// ─── API: جلب طبخة ────────────────────────────────────────
app.post('/meal', async (req, res) => {
  const { cuisine, excludeNames = [], mealName } = req.body;

  // بحث بالاسم
  if (mealName) {
    try {
      const meal = await fetchMealFromAI(mealName);
      return res.json({ success: true, meal, fromCache: false });
    } catch (err) {
      return res.json({ success: false, error: err.message });
    }
  }

  // ابحث بالمخزن
  const query = { used: false };
  if (cuisine && cuisine !== 'any') query.cuisine = { $regex: cuisine, $options: 'i' };
  if (excludeNames.length > 0) query.name = { $nin: excludeNames };

  const count = await Meal.countDocuments(query);

  if (count > 0) {
    const skip = Math.floor(Math.random() * count);
    const meal = await Meal.findOne(query).skip(skip).lean();

    if (meal) {
      await Meal.updateOne({ _id: meal._id }, { used: true });
      totalSaved++;
      console.log(`📦 من المخزن: ${meal.name} | وفّرنا: ${totalSaved} | باقي: ${count - 1}`);

      if (count - 1 <= REFILL_AT) refillPool(POOL_SIZE);

      const { _id, __v, used, createdAt, ...cleanMeal } = meal;
      return res.json({ success: true, meal: cleanMeal, fromCache: true });
    }
  }

  // المخزن فاضي
  console.log('⚡ المخزن فاضي، جاري الجلب من ChatGPT...');
  try {
    const meal = await fetchMealFromAI(cuisine !== 'any' ? cuisine : '');
    res.json({ success: true, meal, fromCache: false });
    refillPool(POOL_SIZE);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── API: إحصائيات ────────────────────────────────────────
app.get('/stats', async (req, res) => {
  const poolSize = await Meal.countDocuments({ used: false });
  const totalInDB = await Meal.countDocuments();
  res.json({
    poolSize,
    totalInDB,
    totalSaved,
    message: `المخزن فيه ${poolSize} طبخة | إجمالي الطبخات بـ DB: ${totalInDB} | وفّرنا ${totalSaved} طلب`
  });
});

app.get('/meals', async (req, res) => {
  const meals = await Meal.find({ used: false }, 'name emoji cuisine').lean();
  res.json({ total: meals.length, meals });
});

app.get('/', (req, res) => res.send('🍽️ طبخة اليوم Server يشتغل ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ السيرفر شتغل على port ${PORT}`));
