import { createFileRoute } from "@tanstack/react-router";
import { Instagram, MessageCircle, Music2, Users } from "lucide-react";

import { PageHeader, PageShell } from "@/components/ui-kit";
import { contactInfo } from "@/data/site";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact — Al-Mustatil Al-Akhdar" },
      {
        name: "description",
        content:
          "Contact Al-Mustatil Al-Akhdar on WhatsApp (+965 51287700), join the WhatsApp group, or follow us on Instagram and TikTok.",
      },
      { property: "og:title", content: "Contact — Al-Mustatil Al-Akhdar" },
      {
        property: "og:description",
        content: "WhatsApp, community group, Instagram and TikTok links.",
      },
      { property: "og:url", content: "/contact" },
    ],
    links: [{ rel: "canonical", href: "/contact" }],
  }),
  component: ContactPage,
});

function ContactPage() {
  const { t } = useI18n();

  const cards = [
    {
      icon: MessageCircle,
      label: t("contact.whatsapp"),
      value: contactInfo.phone,
      href: `https://wa.me/${contactInfo.whatsappNumber}`,
    },
    {
      icon: Users,
      label: t("contact.group"),
      value: t("contact.groupCta"),
      href: contactInfo.whatsappGroup,
    },
    {
      icon: Instagram,
      label: t("contact.instagram"),
      value: contactInfo.instagramHandle,
      href: contactInfo.instagram,
    },
    {
      icon: Music2,
      label: t("contact.tiktok"),
      value: contactInfo.tiktokHandle,
      href: contactInfo.tiktok,
    },
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow={t("brand")}
        title={t("contact.title")}
        subtitle={t("contact.sub")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map(({ icon: Icon, label, value, href }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="glass-card flex min-h-24 items-center gap-4 p-5 transition-transform duration-300 hover:-translate-y-0.5 hover:border-gold/40 sm:p-6"
          >
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-gold/30 bg-gold/10">
              <Icon className="h-6 w-6 text-gold" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-[11px] tracking-[0.18em] text-muted-foreground uppercase">
                {label}
              </span>
              <span className="mt-1 block truncate font-display text-xl font-semibold">
                {value}
              </span>
            </span>
          </a>
        ))}
      </div>
    </PageShell>
  );
}
