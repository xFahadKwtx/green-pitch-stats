import { createFileRoute } from "@tanstack/react-router";
import {
  Clock,
  Coins,
  Flame,
  Gift,
  MinusCircle,
  PauseCircle,
  Percent,
  ShoppingBag,
  ShieldAlert,
  Star,
  Target,
  Trophy,
  UserPlus,
} from "lucide-react";

import { Badge, PageHeader, PageShell, SectionTitle } from "@/components/ui-kit";
import { positionChallenges } from "@/data/site";
import { useI18n, type TKey } from "@/lib/i18n";

export const Route = createFileRoute("/rewards")({
  head: () => ({
    meta: [
      { title: "Rewards & Criteria — Al-Mustatil Al-Akhdar" },
      {
        name: "description",
        content:
          "Match MVP, Player of the Month, position challenges and referral rewards, plus the official ranking criteria for every title.",
      },
      { property: "og:title", content: "Rewards & Criteria — Al-Mustatil Al-Akhdar" },
      {
        property: "og:description",
        content: "Free matches, monthly discounts and the official competition criteria.",
      },
      { property: "og:url", content: "/rewards" },
    ],
    links: [{ rel: "canonical", href: "/rewards" }],
  }),
  component: RewardsPage,
});

const criteria: { title: TKey; rules: string[]; rulesAr: string[] }[] = [
  {
    title: "lb.potm",
    rules: ["Most Match MVP awards", "Most games played", "Highest rating"],
    rulesAr: ["أكثر جوائز أفضل لاعب في المباراة", "أكثر عدد مباريات", "أعلى تقييم"],
  },
  {
    title: "lb.scorer",
    rules: ["Most goals", "Fewer games played", "More assists", "Highest rating"],
    rulesAr: ["أكثر أهداف", "عدد مباريات أقل", "تمريرات حاسمة أكثر", "أعلى تقييم"],
  },
  {
    title: "lb.assists",
    rules: ["Most assists", "Fewer games played", "More goals", "Highest rating"],
    rulesAr: ["أكثر تمريرات حاسمة", "عدد مباريات أقل", "أهداف أكثر", "أعلى تقييم"],
  },
  {
    title: "lb.defender",
    rules: ["Most tackles", "Fewer games played", "Highest rating"],
    rulesAr: ["أكثر التحامات", "عدد مباريات أقل", "أعلى تقييم"],
  },
  {
    title: "lb.passing",
    rules: ["Highest pass accuracy", "Fewer games played", "Highest rating"],
    rulesAr: ["أعلى دقة تمرير", "عدد مباريات أقل", "أعلى تقييم"],
  },
  {
    title: "lb.keeperTitle",
    rules: ["Highest save percentage", "Fewer games played", "Highest rating"],
    rulesAr: ["أعلى نسبة تصدي", "عدد مباريات أقل", "أعلى تقييم"],
  },
];

const pointsSections: {
  icon: typeof Coins;
  titleEn: string;
  titleAr: string;
  introEn?: string;
  introAr?: string;
  itemsEn: string[];
  itemsAr: string[];
}[] = [
  {
    icon: Coins,
    titleEn: "Points System",
    titleAr: "نظام النقاط",
    introEn:
      "The Green Rectangle Points System rewards players for participation, commitment, consistency, and sportsmanship. Every player receives a certain number of points after each match according to the official Green Rectangle Points System.",
    introAr:
      "يكافئ نظام نقاط المستطيل الأخضر اللاعبين على المشاركة والالتزام والمواظبة والروح الرياضية. يحصل كل لاعب على عدد معين من النقاط بعد كل مباراة وفقاً لنظام نقاط المستطيل الأخضر الرسمي.",
    itemsEn: [
      "Points are awarded in 0.25-point increments: 0 – 0.25 – 0.50 – 0.75 – 1.00 and so on.",
    ],
    itemsAr: [
      "تُمنح النقاط بزيادات مقدارها 0.25 نقطة: 0 – 0.25 – 0.50 – 0.75 – 1.00 وهكذا.",
    ],
  },
  {
    icon: Star,
    titleEn: "Challenge Points",
    titleAr: "نقاط التحدي",
    introEn:
      "Players can earn additional points by completing Position Challenges during matches.",
    introAr: "يمكن للاعبين كسب نقاط إضافية من خلال إكمال تحديات المراكز خلال المباريات.",
    itemsEn: ["Each challenge awards a certain number of additional points depending on the challenge."],
    itemsAr: ["كل تحدٍ يمنح عدداً معيناً من النقاط الإضافية بحسب نوع التحدي."],
  },
  {
    icon: Flame,
    titleEn: "Loyalty Points",
    titleAr: "نقاط الولاء",
    itemsEn: [
      "A player who participates in 5 consecutive matches receives 3 Loyalty Points as a reward for consistency and commitment.",
    ],
    itemsAr: [
      "اللاعب الذي يشارك في 5 مباريات متتالية يحصل على 3 نقاط ولاء مكافأةً على مواظبته والتزامه.",
    ],
  },
  {
    icon: Clock,
    titleEn: "Late Arrival Deductions",
    titleAr: "خصومات التأخر",
    itemsEn: [
      "Arriving at the match start time or up to 5 minutes late: -0.25 points",
      "More than 5 minutes and up to 15 minutes late: -0.50 points",
      "More than 15 minutes and up to 30 minutes late: -1 point",
      "More than 30 minutes late: -2 points",
    ],
    itemsAr: [
      "الوصول عند بداية المباراة أو التأخر حتى 5 دقائق: ‎-0.25 نقطة",
      "التأخر أكثر من 5 دقائق وحتى 15 دقيقة: ‎-0.50 نقطة",
      "التأخر أكثر من 15 دقيقة وحتى 30 دقيقة: ‎-1 نقطة",
      "التأخر أكثر من 30 دقيقة: ‎-2 نقطة",
    ],
  },
  {
    icon: MinusCircle,
    titleEn: "Cancellation & No-Show",
    titleAr: "الإلغاء وعدم الحضور",
    itemsEn: [
      "Cancellation 5 hours or more before the match: No deduction",
      "Cancellation within the last 5 hours before the match: -0.50 points",
      "Confirmed participation followed by cancellation without informing the organizer — if the match fee has already been paid: -1.50 points",
      "Confirmed participation followed by cancellation without informing the organizer — if the match fee has not been paid: -2 points",
    ],
    itemsAr: [
      "الإلغاء قبل المباراة بـ 5 ساعات أو أكثر: لا يوجد خصم",
      "الإلغاء خلال آخر 5 ساعات قبل المباراة: ‎-0.50 نقطة",
      "تأكيد المشاركة ثم الإلغاء دون إبلاغ المنظم — إذا تم دفع رسوم المباراة مسبقاً: ‎-1.50 نقطة",
      "تأكيد المشاركة ثم الإلغاء دون إبلاغ المنظم — إذا لم يتم دفع رسوم المباراة: ‎-2 نقطة",
    ],
  },
  {
    icon: ShieldAlert,
    titleEn: "On-Field Conduct",
    titleAr: "السلوك داخل الملعب",
    itemsEn: [
      "Excessive arguing with the referee: -0.75 points",
      "Abusive language toward other players: -1 point + player warning",
    ],
    itemsAr: [
      "الاحتجاج المفرط على الحكم: ‎-0.75 نقطة",
      "استخدام ألفاظ مسيئة تجاه اللاعبين الآخرين: ‎-1 نقطة + إنذار للاعب",
    ],
  },
  {
    icon: ShieldAlert,
    titleEn: "Cards",
    titleAr: "البطاقات",
    itemsEn: [
      "Yellow card: -0.25 points",
      "Red card resulting from a second yellow card: -0.50 points",
      "Straight red card: -2 points",
    ],
    itemsAr: [
      "البطاقة الصفراء: ‎-0.25 نقطة",
      "البطاقة الحمراء الناتجة عن بطاقة صفراء ثانية: ‎-0.50 نقطة",
      "البطاقة الحمراء المباشرة: ‎-2 نقطة",
    ],
  },
  {
    icon: PauseCircle,
    titleEn: "Inactivity Deductions",
    titleAr: "خصومات الخمول",
    itemsEn: [
      "10 consecutive missed matches: Deduct 20% of the player's total points balance",
      "15 consecutive missed matches: Deduct 50% of the player's total points balance",
      "20 consecutive missed matches: Deduct 100% of the player's total points balance",
    ],
    itemsAr: [
      "الغياب عن 10 مباريات متتالية: خصم 20% من إجمالي رصيد نقاط اللاعب",
      "الغياب عن 15 مباراة متتالية: خصم 50% من إجمالي رصيد نقاط اللاعب",
      "الغياب عن 20 مباراة متتالية: خصم 100% من إجمالي رصيد نقاط اللاعب",
    ],
  },
  {
    icon: PauseCircle,
    titleEn: "Freeze",
    titleAr: "التجميد",
    itemsEn: [
      "Each player has access to a Freeze option. When activated, the player can pause the effect of inactivity on their points for up to 20 days.",
      "During an active Freeze period, the absence period does not count toward inactivity-related point deductions.",
      "The Freeze option can be used once every two months.",
    ],
    itemsAr: [
      "يملك كل لاعب خيار التجميد. عند تفعيله، يمكن للاعب إيقاف تأثير الخمول على نقاطه لمدة تصل إلى 20 يوماً.",
      "خلال فترة التجميد النشطة، لا تُحتسب فترة الغياب ضمن خصومات النقاط المتعلقة بالخمول.",
      "يمكن استخدام خيار التجميد مرة واحدة كل شهرين.",
    ],
  },
  {
    icon: ShoppingBag,
    titleEn: "Using Your Points",
    titleAr: "استخدام نقاطك",
    itemsEn: [
      "Discounts on match fees",
      "Cashback",
      "Purchasing products available in the Green Rectangle Store using points",
      "Every product in the Store includes an Order Product button that opens a WhatsApp conversation with the Green Rectangle administrator. The message comes pre-filled with your order request, the product name, its value / required points, and relevant product details — you only need to send the prepared message to complete the request.",
    ],
    itemsAr: [
      "خصومات على رسوم المباريات",
      "استرداد نقدي",
      "شراء المنتجات المتوفرة في متجر المستطيل الأخضر باستخدام النقاط",
      "يتضمن كل منتج في المتجر زر «اطلب المنتج» الذي يفتح محادثة واتساب مع إدارة المستطيل الأخضر. تكون الرسالة جاهزة مسبقاً وتتضمن طلبك واسم المنتج وقيمته / النقاط المطلوبة وتفاصيل المنتج — كل ما عليك هو إرسال الرسالة الجاهزة لإتمام الطلب.",
    ],
  },
];

function RewardCard({
  icon: Icon,
  title,
  body,
  value,
  children,
}: {
  icon: typeof Gift;
  title: string;
  body: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <article className="glass-card flex flex-col gap-3 p-5 transition-transform duration-300 hover:-translate-y-0.5 hover:border-gold/40 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-gold/30 bg-gold/10">
          <Icon className="h-5 w-5 text-gold" aria-hidden />
        </span>
        <h3 className="min-w-0 text-lg font-bold tracking-wide uppercase sm:text-xl">
          {title}
        </h3>
      </div>
      <p className="stat-number text-2xl text-gold sm:text-3xl">{value}</p>
      <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
      {children}
    </article>
  );
}

function RewardsPage() {
  const { t, lang } = useI18n();

  return (
    <PageShell>
      <PageHeader
        eyebrow={t("brand")}
        title={t("rewards.title")}
        subtitle={t("rewards.sub")}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <RewardCard
          icon={Trophy}
          title={t("rewards.mvp")}
          body={t("rewards.mvp.body")}
          value={lang === "ar" ? "مباراة مجانية أو 8 نقاط" : "Free Match OR 8 Points"}
        />
        <RewardCard
          icon={Percent}
          title={t("rewards.potm")}
          body={t("rewards.potm.body")}
          value={
            lang === "ar"
              ? "خصم 50% لمدة شهر أو 70 نقطة"
              : "50% Off One Month OR 70 Points"
          }
        />
        <RewardCard
          icon={Target}
          title={t("rewards.challenge")}
          body={t("rewards.challenge.body")}
          value={lang === "ar" ? "1.5 نقطة" : "1.5 Points"}
        >
          <ul className="grid gap-2">
            {positionChallenges.map((c) => (
              <li
                key={c.position}
                className="flex items-start gap-3 rounded-xl border border-border bg-glass px-4 py-3 text-sm"
              >
                <span className="stat-number shrink-0 text-gold">{c.position}</span>
                <span className="min-w-0 text-muted-foreground">
                  {lang === "ar" ? c.challengeAr : c.challenge}
                </span>
              </li>
            ))}
          </ul>
        </RewardCard>
        <RewardCard
          icon={UserPlus}
          title={t("rewards.bring")}
          body={t("rewards.bring.body")}
          value={lang === "ar" ? "0.25 نقطة لكل لاعب" : "0.25 Points per Player"}
        />
      </div>

      <div className="mt-12">
        <SectionTitle>{t("rewards.criteria")}</SectionTitle>
        <p className="mb-5 text-sm text-muted-foreground">{t("rewards.criteria.sub")}</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {criteria.map((c) => (
            <article key={c.title} className="glass-card p-5">
              <Badge>{t(c.title)}</Badge>
              <ol className="mt-4 grid gap-2">
                {(lang === "ar" ? c.rulesAr : c.rules).map((rule, i) => (
                  <li key={rule} className="flex items-start gap-3 text-sm">
                    <span className="stat-number grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border bg-glass text-xs text-gold">
                      {i + 1}
                    </span>
                    <span className="min-w-0 text-muted-foreground">{rule}</span>
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      </div>

      <div className="mt-12">
        <SectionTitle>{lang === "ar" ? "نظام النقاط" : "Points System"}</SectionTitle>
        <p className="mb-5 text-sm text-muted-foreground">
          {lang === "ar"
            ? "كيف تُمنح النقاط وتُخصم وكيف تستفيد منها في المستطيل الأخضر."
            : "How points are earned, deducted, and used in the Green Rectangle."}
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pointsSections.map((section) => (
            <article
              key={section.titleEn}
              className="glass-card flex flex-col gap-3 p-5 transition-transform duration-300 hover:-translate-y-0.5 hover:border-gold/40 sm:p-6"
            >
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-gold/30 bg-gold/10">
                  <section.icon className="h-5 w-5 text-gold" aria-hidden />
                </span>
                <h3 className="min-w-0 text-lg font-bold tracking-wide uppercase sm:text-xl">
                  {lang === "ar" ? section.titleAr : section.titleEn}
                </h3>
              </div>
              {section.introEn ? (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {lang === "ar" ? section.introAr : section.introEn}
                </p>
              ) : null}
              <ul className="grid gap-2">
                {(lang === "ar" ? section.itemsAr : section.itemsEn).map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3 rounded-xl border border-border bg-glass px-4 py-3 text-sm"
                  >
                    <span
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gold"
                      aria-hidden
                    />
                    <span className="min-w-0 text-muted-foreground">{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </PageShell>
  );
}
