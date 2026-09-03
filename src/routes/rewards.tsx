import { createFileRoute } from "@tanstack/react-router";
import { Gift, Percent, Target, Trophy, UserPlus } from "lucide-react";

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
    ],
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
          value={lang === "ar" ? "مباراة مجانية" : "1 Free Match"}
        />
        <RewardCard
          icon={Percent}
          title={t("rewards.potm")}
          body={t("rewards.potm.body")}
          value={lang === "ar" ? "خصم 50% / شهر" : "50% Off / Month"}
        />
        <RewardCard
          icon={Target}
          title={t("rewards.challenge")}
          body={t("rewards.challenge.body")}
          value={lang === "ar" ? "خصم 50%" : "50% Off"}
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
          value={lang === "ar" ? "خصم 10%" : "10% Off"}
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

    </PageShell>
  );
}
