import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Lang = "en" | "ar";

const dict = {
  en: {
    brand: "Al-Mustatil Al-Akhdar",
    brandTag: "Football Performance Platform",
    "nav.home": "Home",
    "nav.games": "Upcoming Games",
    "nav.players": "Players Stats",
    "nav.leaderboard": "Leaderboard",
    "nav.store": "Store",
    "nav.rewards": "Rewards",
    "nav.contact": "Contact",
    "nav.compare": "Compare Players",
    "nav.records": "Records",

    menu: "Menu",
    close: "Close",
    "home.hero.title": "Every touch counted.",
    "home.hero.sub":
      "Weekly bookings, full match data and monthly awards for the Al-Mustatil Al-Akhdar community.",
    "home.cta.games": "Upcoming Games",
    "home.cta.stats": "Players Stats",
    "home.stats.players": "Players tracked",
    "home.stats.matches": "Matches logged",
    "home.stats.metrics": "Metrics per match",
    "home.quick": "Explore",
    "games.title": "Upcoming Games",
    "games.sub": "Bookings available this week. Registration is confirmed on WhatsApp.",
    "games.register": "Register on WhatsApp",
    "games.spots": "spots left",
    "games.location": "Location",
    "games.time": "Time",
    "games.date": "Date",
    "games.day": "Day",
    "games.empty": "No upcoming games at the moment.",
    "players.title": "Players Stats",
    "players.sub": "Browse the squad and open any player for full match statistics.",
    "players.search": "Search player name",
    "players.count": "players",
    "players.empty": "No players match your search.",
    "players.viewProfile": "View profile",
    "compare.title": "Player Comparison",
    "compare.sub":
      "Pick two players to see their statistics side by side for the same month.",
    "compare.player1": "Player 1",
    "compare.player2": "Player 2",
    "compare.select": "Select a player",
    "compare.statistic": "Statistic",
    "compare.pickBoth": "Select two players to start comparing.",
    "compare.noShared":
      "No shared statistics to display for these two players in this period.",
    "records.title": "Records",
    "records.sub":
      "The marks to chase. Every record here can be broken — claim it and become the new holder.",
    "records.eyebrow": "Breakable Records",
    "records.holder": "Current record holder",
    "records.unclaimed": "No player has broken this record yet",
    "records.empty": "No records published yet.",

    "profile.points": "Points Balance",
    "profile.back": "All players",
    "profile.stats": "Statistics",
    "profile.outfield": "Outfield Stats",
    "profile.keeper": "Goalkeeper Stats",
    "profile.noData": "No statistics recorded for this period.",
    "filter.all": "All",
    "month.2026-06": "June 2026",
    "month.2026-07": "July 2026",
    "month.2026-08": "August 2026",
    "month.2026-09": "September 2026",
    "pos.GK": "Goalkeeper",
    "pos.DEF": "Defender",
    "pos.MID": "Midfielder",
    "pos.FWD": "Forward",
    "stat.goals": "Goals",
    "stat.assists": "Assists",
    "stat.shots": "Total Shots",
    "stat.sot": "Shots on Target",
    "stat.passes": "Total Passes",
    "stat.passAcc": "Pass Accuracy",
    "stat.tackles": "Tackles",
    "stat.clearances": "Clearances",
    "stat.dribbles": "Successful Dribbles",
    "stat.keyPasses": "Key Passes",
    "stat.chances": "Chances Created",
    "stat.lowRating": "Lowest Rating",
    "stat.saves": "Saves",
    "stat.shotsFaced": "Shots Faced",
    "stat.conceded": "Goals Conceded",
    "stat.savePct": "Save Percentage",
    "stat.games": "Games Played",
    "stat.mvp": "MVP Awards",
    "stat.highRating": "Highest Rating",
    "lb.title": "Leaderboard",
    "lb.sub": "Monthly rankings across every competition category.",
    "lb.rank": "#",
    "lb.player": "Player Name",
    "lb.keeper": "Goalkeeper Name",
    "lb.potm": "Player of the Month",
    "lb.scorer": "Top Scorer",
    "lb.assists": "Top Assists",
    "lb.defender": "Best Defender",
    "lb.passing": "Highest Pass Accuracy",
    "lb.keeperTitle": "Best Goalkeeper",
    "lb.empty": "No data for this period.",
    "store.title": "Store",
    "store.sub": "Official Al-Mustatil Al-Akhdar kit and gear.",
    "store.empty.title": "The store is being prepared",
    "store.empty.body":
      "Products will be published here soon. Follow us on WhatsApp or Instagram for the drop.",
    "store.notify": "Ask about the store",
    "rewards.title": "Rewards",
    "rewards.sub": "Benefits, offers and the official competition criteria.",
    "rewards.mvp": "Player of the Match Reward",
    "rewards.mvp.body": "The player can choose either a free match or 8 points.",
    "rewards.potm": "Player of the Month Reward",
    "rewards.potm.body":
      "The player can choose either a 50% discount for one month or 70 points.",
    "rewards.challenge": "Position Challenge Reward",
    "rewards.challenge.body":
      "The player receives 1.5 points for successfully completing the Position Challenge.",
    "rewards.challenge.soon": "Position challenges will be announced soon.",
    "rewards.bring": "Bring a Player Reward",
    "rewards.bring.body":
      "Earn 0.25 points for each player you bring, with a maximum of 4 players per match.",
    "rewards.criteria": "Competition Criteria",
    "rewards.criteria.sub": "How each title is decided, in order of priority.",
    "contact.title": "Contact",
    "contact.sub": "Reach the organisers or join the community.",
    "contact.whatsapp": "WhatsApp / Contact",
    "contact.group": "WhatsApp Group",
    "contact.groupCta": "Join the group",
    "contact.instagram": "Instagram",
    "contact.tiktok": "TikTok",
    "footer.rights": "All rights reserved.",
    lang: "العربية",
  },
  ar: {
    brand: "المستطيل الأخضر",
    brandTag: "منصة أداء كرة القدم",
    "nav.home": "الرئيسية",
    "nav.games": "المباريات القادمة",
    "nav.players": "إحصائيات اللاعبين",
    "nav.leaderboard": "لوحة الصدارة",
    "nav.store": "المتجر",
    "nav.rewards": "المكافآت",
    "nav.contact": "اتصل بنا",
    "nav.compare": "مقارنة اللاعبين",
    "nav.records": "الأرقام القياسية",

    menu: "القائمة",
    close: "إغلاق",
    "home.hero.title": "كل لمسة محسوبة.",
    "home.hero.sub":
      "حجوزات أسبوعية، بيانات كاملة للمباريات، وجوائز شهرية لمجتمع المستطيل الأخضر.",
    "home.cta.games": "المباريات القادمة",
    "home.cta.stats": "إحصائيات اللاعبين",
    "home.stats.players": "لاعب مسجّل",
    "home.stats.matches": "مباراة موثقة",
    "home.stats.metrics": "مؤشر لكل مباراة",
    "home.quick": "استكشف",
    "games.title": "المباريات القادمة",
    "games.sub": "الحجوزات المتاحة هذا الأسبوع. يتم تأكيد التسجيل عبر واتساب.",
    "games.register": "التسجيل عبر واتساب",
    "games.spots": "مقعد متاح",
    "games.location": "الموقع",
    "games.time": "الوقت",
    "games.date": "التاريخ",
    "games.day": "اليوم",
    "games.empty": "لا توجد حجوزات قادمة حالياً.",
    "players.title": "إحصائيات اللاعبين",
    "players.sub": "استعرض الفريق وافتح أي لاعب لعرض إحصائياته الكاملة.",
    "players.search": "ابحث باسم اللاعب",
    "players.count": "لاعب",
    "players.empty": "لا يوجد لاعب مطابق للبحث.",
    "players.viewProfile": "عرض الملف",
    "compare.title": "مقارنة اللاعبين",
    "compare.sub": "اختر لاعبين لعرض إحصائياتهما جنباً إلى جنب لنفس الشهر.",
    "compare.player1": "اللاعب الأول",
    "compare.player2": "اللاعب الثاني",
    "compare.select": "اختر لاعباً",
    "compare.statistic": "الإحصائية",
    "compare.pickBoth": "اختر لاعبين للبدء بالمقارنة.",
    "compare.noShared": "لا توجد إحصائيات مشتركة لعرضها لهذين اللاعبين في هذه الفترة.",
    "records.title": "الأرقام القياسية",
    "records.sub":
      "العلامات التي يجب اللحاق بها. كل رقم هنا قابل للكسر — اكسره وكن صاحب الرقم الجديد.",
    "records.eyebrow": "أرقام قياسية قابلة للكسر",
    "records.holder": "صاحب الرقم الحالي",
    "records.unclaimed": "لم يكسر أي لاعب هذا الرقم القياسي حتى الآن",
    "records.empty": "لا توجد أرقام قياسية منشورة بعد.",

    "profile.points": "رصيد النقاط",
    "profile.back": "كل اللاعبين",
    "profile.stats": "الإحصائيات",
    "profile.outfield": "إحصائيات الملعب",
    "profile.keeper": "إحصائيات حراسة المرمى",
    "profile.noData": "لا توجد إحصائيات مسجلة لهذه الفترة.",
    "filter.all": "الكل",
    "month.2026-06": "يونيو 2026",
    "month.2026-07": "يوليو 2026",
    "month.2026-08": "أغسطس 2026",
    "month.2026-09": "سبتمبر 2026",
    "pos.GK": "حارس مرمى",
    "pos.DEF": "مدافع",
    "pos.MID": "وسط",
    "pos.FWD": "مهاجم",
    "stat.goals": "الأهداف",
    "stat.assists": "التمريرات الحاسمة",
    "stat.shots": "إجمالي التسديدات",
    "stat.sot": "تسديدات على الهدف",
    "stat.passes": "إجمالي التمريرات",
    "stat.passAcc": "دقة التمرير",
    "stat.tackles": "الالتحامات",
    "stat.clearances": "التشتيتات",
    "stat.dribbles": "المراوغات الناجحة",
    "stat.keyPasses": "التمريرات المفتاحية",
    "stat.chances": "الفرص المصنوعة",
    "stat.lowRating": "أدنى تقييم",
    "stat.saves": "التصديات",
    "stat.shotsFaced": "التسديدات المواجهة",
    "stat.conceded": "الأهداف المستقبلة",
    "stat.savePct": "نسبة التصدي",
    "stat.games": "المباريات",
    "stat.mvp": "جوائز الأفضل",
    "stat.highRating": "أعلى تقييم",
    "lb.title": "لوحة الصدارة",
    "lb.sub": "الترتيب الشهري في جميع فئات المنافسة.",
    "lb.rank": "#",
    "lb.player": "اسم اللاعب",
    "lb.keeper": "اسم الحارس",
    "lb.potm": "لاعب الشهر",
    "lb.scorer": "الهداف",
    "lb.assists": "صاحب أكثر تمريرات حاسمة",
    "lb.defender": "أفضل مدافع",
    "lb.passing": "أعلى دقة تمرير",
    "lb.keeperTitle": "أفضل حارس مرمى",
    "lb.empty": "لا توجد بيانات لهذه الفترة.",
    "store.title": "المتجر",
    "store.sub": "منتجات المستطيل الأخضر الرسمية.",
    "store.empty.title": "المتجر قيد التحضير",
    "store.empty.body":
      "سيتم نشر المنتجات هنا قريباً. تابعنا على واتساب أو إنستقرام لمعرفة موعد الإطلاق.",
    "store.notify": "استفسر عن المتجر",
    "rewards.title": "المكافآت",
    "rewards.sub": "المزايا والعروض ومعايير المنافسة الرسمية.",
    "rewards.mvp": "مكافأة رجل المباراة",
    "rewards.mvp.body": "يختار اللاعب بين مباراة مجانية أو 8 نقاط.",
    "rewards.potm": "مكافأة لاعب الشهر",
    "rewards.potm.body": "يختار اللاعب بين خصم 50% لمدة شهر أو 70 نقطة.",
    "rewards.challenge": "مكافأة تحدي المركز",
    "rewards.challenge.body": "يحصل اللاعب على 1.5 نقطة عند إكمال تحدي المركز بنجاح.",
    "rewards.challenge.soon": "سيتم الإعلان عن تحديات المراكز قريباً.",
    "rewards.bring": "مكافأة إحضار لاعب",
    "rewards.bring.body": "يحصل اللاعب على 0.25 نقطة عن كل لاعب يحضره، بحد أقصى 4 لاعبين لكل مباراة.",
    "rewards.criteria": "معايير المنافسة",
    "rewards.criteria.sub": "كيف يتم حسم كل لقب، حسب الأولوية.",
    "contact.title": "اتصل بنا",
    "contact.sub": "تواصل مع المنظمين أو انضم إلى المجتمع.",
    "contact.whatsapp": "واتساب / التواصل",
    "contact.group": "مجموعة واتساب",
    "contact.groupCta": "انضم إلى المجموعة",
    "contact.instagram": "إنستقرام",
    "contact.tiktok": "تيك توك",
    "footer.rights": "جميع الحقوق محفوظة.",
    lang: "English",
  },
} as const;

export type TKey = keyof (typeof dict)["en"];

interface I18nValue {
  lang: Lang;
  dir: "ltr" | "rtl";
  setLang: (l: Lang) => void;
  toggle: () => void;
  t: (key: TKey) => string;
}

// Kept on globalThis so hot module replacement reuses the same context object
// instead of creating a second one that the mounted provider doesn't fill.
const globalCtxStore = globalThis as typeof globalThis & {
  __maaI18nContext?: ReturnType<typeof createContext<I18nValue | null>>;
};
const I18nContext = (globalCtxStore.__maaI18nContext ??= createContext<I18nValue | null>(null));
const STORAGE_KEY = "maa-lang";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "ar" || saved === "en") setLangState(saved);
  }, []);

  useEffect(() => {
    const dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.setAttribute("dir", dir);
    document.documentElement.setAttribute("lang", lang);
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      dir: lang === "ar" ? "rtl" : "ltr",
      setLang,
      toggle: () => setLang(lang === "ar" ? "en" : "ar"),
      t: (key: TKey) => dict[lang][key] ?? dict.en[key] ?? String(key),
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}
