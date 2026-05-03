// server.js - سيرفر طبخة اليوم مع Meal Pool + YouTube
const express  = require('express');
const app      = express();
app.use(express.json());

const OPENAI_KEY  = process.env.OPENAI_KEY;
const YOUTUBE_KEY = process.env.YOUTUBE_KEY;

const POOL_SIZE     = 50;
const REFILL_AT     = 10;
const CUISINE_TYPES = ['سورية', 'مصرية', 'لبنانية', 'خليجية', 'مغربية', 'تركية', 'إيطالية', 'إسبانية'];

let mealPool    = [];
let isRefilling = false;
let totalSaved  = 0;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

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

  const video = await fetchYoutubeVideo(meal.search || meal.name);
  if (video) {
    meal.videoId = video.videoId;
    meal.thumb   = video.thumb;
  }

  return meal;
}

async function refillPool(count = 10) {
  if (isRefilling) return;
  isRefilling = true;
  console.log(`🔄 جاري تعبئة ${count} طبخة...`);

  const promises = Array.from({ length: count }, (_, i) => {
    const cuisine = CUISINE_TYPES[i % CUISINE_TYPES.length];
    return fetchMealFromAI(cuisine).catch(err => {
      console.error('خطأ في جلب طبخة:', err.message);
      return null;
    });
  });

  const meals      = await Promise.all(promises);
  const validMeals = meals.filter(Boolean);
  const existingNames = new Set(mealPool.map(m => m.name));
  const newMeals      = validMeals.filter(m => !existingNames.has(m.name));
  
  mealPool.push(...newMeals);
  isRefilling = false;
  console.log(`✅ المخزن الآن: ${mealPool.length} طبخة`);
}

refillPool(POOL_SIZE);

app.post('/meal', async (req, res) => {
  const { cuisine, excludeNames = [] } = req.body;

  if (req.body.mealName) {
    try {
      const meal = await fetchMealFromAI(req.body.mealName);
      return res.json({ success: true, meal, fromCache: false });
    } catch (err) {
      return res.json({ success: false, error: err.message });
    }
  }

  let availableMeals = mealPool.filter(m => {
    if (excludeNames.includes(m.name)) return false;
    if (cuisine && cuisine !== 'any' && !m.cuisine?.includes(cuisine)) return false;
    return true;
  });

  if (availableMeals.length > 0) {
    const randomIndex = Math.floor(Math.random() * availableMeals.length);
    const meal        = availableMeals[randomIndex];
    mealPool          = mealPool.filter(m => m.name !== meal.name);
    totalSaved++;
    console.log(`📦 من المخزن: ${meal.name} | وفّرنا: ${totalSaved} طلب | باقي: ${mealPool.length}`);
    if (mealPool.length <= REFILL_AT) refillPool(POOL_SIZE - mealPool.length);
    return res.json({ success: true, meal, fromCache: true });
  }

  console.log('⚡ المخزن فاضي، جاري الجلب من ChatGPT...');
  try {
    const meal = await fetchMealFromAI(cuisine !== 'any' ? cuisine : '');
    res.json({ success: true, meal, fromCache: false });
    refillPool(POOL_SIZE);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/stats', (req, res) => {
  res.json({
    poolSize: mealPool.length,
    totalSaved,
    isRefilling,
    message: `المخزن فيه ${mealPool.length} طبخة | وفّرنا ${totalSaved} طلب من ChatGPT`
  });
});

app.get('/meals', (req, res) => {
  res.json({
    total: mealPool.length,
    meals: mealPool.map(m => ({ name: m.name, emoji: m.emoji, cuisine: m.cuisine }))
  });
});

app.get('/', (req, res) => res.send('🍽️ طبخة اليوم Server يشتغل ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ السيرفر شتغل على port ${PORT}`));
