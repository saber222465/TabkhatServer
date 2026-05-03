// server.js - سيرفر طبخة اليوم مع Meal Pool
const express  = require('express');
const app      = express();
app.use(express.json());

// ← حط مفتاح ChatGPT هنا على السيرفر فقط
const OPENAI_KEY = process.env.OPENAI_KEY;

// إعدادات الـ Pool
const POOL_SIZE     = 50;  // عدد الطبخات المحفوظة
const REFILL_AT     = 10;  // ابدأ تعبئة لما يبقى أقل من 10
const CUISINE_TYPES = ['سورية', 'مصرية', 'لبنانية', 'خليجية', 'مغربية', 'تركية', 'إيطالية', 'إسبانية'];

// المخزن
let mealPool     = [];
let isRefilling  = false;
let totalSaved   = 0; // عداد كم طلب وفّرنا

// السماح للتطبيق يوصل
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─── جلب طبخة واحدة من ChatGPT ───────────────────────────
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
        { role: 'user', content: `اقترح وصفة ${cuisineText} أصيلة عشوائية ومفصلة. أجب بـ JSON فقط:
{"name":"اسم الطبخة","emoji":"إيموجي","desc":"وصف شهي","difficulty":"سهل أو متوسط أو صعب","calories":"السعرات","protein":"البروتين بالغرام","carbs":"الكربوهيدرات بالغرام","cuisine":"${cuisineText}","ingredients":[{"item":"المكون","amount":"الكمية الدقيقة"},{"item":"مكون","amount":"كمية"},{"item":"مكون","amount":"كمية"},{"item":"مكون","amount":"كمية"},{"item":"مكون","amount":"كمية"},{"item":"مكون","amount":"كمية"},{"item":"البهارات","amount":"كل بهارة على حدى مثل: ملعقة كمون، نصف ملعقة فلفل"}],"steps":["الخطوة الأولى مفصلة","الخطوة الثانية","الخطوة الثالثة","الخطوة الرابعة","الخطوة الخامسة","الخطوة السادسة"],"tips":"نصيحة مفيدة","time":"وقت التحضير","serves":"عدد الأشخاص","search":"اسم الطبخة recipe youtube"}` }
      ],
      temperature: 1.0,
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  
  const txt   = data.choices?.[0]?.message?.content || '';
  const match = txt.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('فشل تحليل الرد');
  
  return JSON.parse(match[0]);
}

// ─── تعبئة المخزن ─────────────────────────────────────────
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

  const meals = await Promise.all(promises);
  const validMeals = meals.filter(Boolean);
  
  // تأكد ما نكرر نفس الطبخة بالمخزن
  const existingNames = new Set(mealPool.map(m => m.name));
  const newMeals = validMeals.filter(m => !existingNames.has(m.name));
  
  mealPool.push(...newMeals);
  isRefilling = false;
  console.log(`✅ المخزن الآن: ${mealPool.length} طبخة`);
}

// تعبئة أولية عند تشغيل السيرفر
refillPool(POOL_SIZE);

// ─── API: جلب طبخة ────────────────────────────────────────
app.post('/meal', async (req, res) => {
  const { cuisine, excludeNames = [] } = req.body;

  // لو طلب مطبخ معين أو البحث، اجيب من ChatGPT مباشرة
  if (req.body.mealName) {
    try {
      const meal = await fetchMealFromAI(req.body.mealName);
      return res.json({ success: true, meal, fromCache: false });
    } catch (err) {
      return res.json({ success: false, error: err.message });
    }
  }

  // ابحث بالمخزن عن طبخة مناسبة
  let availableMeals = mealPool.filter(m => {
    if (excludeNames.includes(m.name)) return false;
    if (cuisine && cuisine !== 'any' && !m.cuisine?.includes(cuisine)) return false;
    return true;
  });

  if (availableMeals.length > 0) {
    // خذ طبخة عشوائية من المخزن
    const randomIndex = Math.floor(Math.random() * availableMeals.length);
    const meal = availableMeals[randomIndex];
    
    // احذفها من المخزن عشان ما تتكرر
    mealPool = mealPool.filter(m => m.name !== meal.name);
    totalSaved++;
    
    console.log(`📦 من المخزن: ${meal.name} | وفّرنا: ${totalSaved} طلب | باقي: ${mealPool.length}`);
    
    // لو المخزن وصل للحد الأدنى، ابدأ تعبئة بالخلفية
    if (mealPool.length <= REFILL_AT) {
      refillPool(POOL_SIZE - mealPool.length);
    }
    
    return res.json({ success: true, meal, fromCache: true });
  }

  // المخزن فاضي — اجيب من ChatGPT مباشرة
  console.log('⚡ المخزن فاضي، جاري الجلب من ChatGPT...');
  try {
    const meal = await fetchMealFromAI(cuisine !== 'any' ? cuisine : '');
    res.json({ success: true, meal, fromCache: false });
    // أعد تعبئة المخزن
    refillPool(POOL_SIZE);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── API: إحصائيات ────────────────────────────────────────
app.get('/stats', (req, res) => {
  res.json({
    poolSize:   mealPool.length,
    totalSaved,
    isRefilling,
    message:    `المخزن فيه ${mealPool.length} طبخة | وفّرنا ${totalSaved} طلب من ChatGPT`
  });
});

app.get('/', (req, res) => res.send('🍽️ طبخة اليوم Server يشتغل ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ السيرفر شتغل على port ${PORT}`));
