import { Link } from "wouter";
import {
  ArrowLeft, ShieldCheck, HardHat, TrafficCone, Gauge, ParkingSquare,
  Moon, Lock, KeyRound, Database,
} from "lucide-react";

interface Topic {
  icon: typeof ShieldCheck;
  title: string;
  text: string;
}

const RIDING_RULES: Topic[] = [
  {
    icon: HardHat,
    title: "Шлем и экипировка",
    text:
      "Используйте шлем и при возможности защиту для рук и коленей. Светоотражающие элементы делают вас заметнее для водителей.",
  },
  {
    icon: TrafficCone,
    title: "Правила дорожного движения",
    text:
      "Двигайтесь по велодорожкам, соблюдайте сигналы светофора и уступайте дорогу пешеходам. Не выезжайте на встречную полосу.",
  },
  {
    icon: Gauge,
    title: "Скорость",
    text:
      "Держите безопасную скорость, особенно на поворотах, спусках и в местах скопления людей. Тормозите заранее.",
  },
  {
    icon: ParkingSquare,
    title: "Парковка",
    text:
      "Оставляйте транспорт в разрешённых зонах, не загораживая проходы, въезды и пути для пешеходов. Завершайте аренду в приложении.",
  },
  {
    icon: Moon,
    title: "Поездки в тёмное время",
    text:
      "Включайте фонарь, выбирайте освещённые маршруты и снижайте скорость. В дождь и гололёд будьте особенно осторожны.",
  },
];

const PRIVACY_TOPICS: Topic[] = [
  {
    icon: Lock,
    title: "Телефон и почта",
    text:
      "Номер телефона и адрес почты используются только для входа, уведомлений и поддержки. Мы не передаём их третьим лицам для рекламы.",
  },
  {
    icon: KeyRound,
    title: "Платёжные данные",
    text:
      "Реквизиты карт обрабатываются платёжными сервисами. Никому не сообщайте коды из SMS и push — сотрудники сервиса их не запрашивают.",
  },
  {
    icon: Database,
    title: "Хранение и защита данных",
    text:
      "Данные передаются по защищённому соединению и доступны ограниченному кругу сотрудников. Вы можете запросить удаление аккаунта.",
  },
];

export function SafetyPage() {
  return (
    <div className="min-h-full bg-background" data-testid="page-safety">
      <div className="mx-auto max-w-md px-5 pt-6 pb-12">
        <header className="mb-6 flex items-center gap-3">
          <Link
            href="/profile"
            data-testid="link-safety-back"
            aria-label="Назад в профиль"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground hover-elevate shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
              BaltCircle
            </div>
            <h1 className="font-display text-2xl font-light leading-tight">Центр безопасности</h1>
          </div>
        </header>

        <Section
          icon={ShieldCheck}
          title="Безопасная поездка"
          intro="Базовые правила, чтобы поездка была безопасной для вас и окружающих."
          topics={RIDING_RULES}
          testId="section-riding-rules"
        />

        <Section
          icon={Lock}
          title="Конфиденциальность и данные"
          intro="Как мы защищаем ваши персональные и платёжные данные."
          topics={PRIVACY_TOPICS}
          testId="section-privacy"
        />
      </div>
    </div>
  );
}

function Section({
  icon: Icon, title, intro, topics, testId,
}: {
  icon: typeof ShieldCheck;
  title: string;
  intro: string;
  topics: Topic[];
  testId: string;
}) {
  return (
    <section className="mb-7" data-testid={testId}>
      <div className="flex items-center gap-2 mb-2 px-1">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <h2 className="font-display text-lg font-light">{title}</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-3 px-1">{intro}</p>
      <div className="space-y-3">
        {topics.map((t) => (
          <TopicCard key={t.title} topic={t} />
        ))}
      </div>
    </section>
  );
}

function TopicCard({ topic }: { topic: Topic }) {
  const Icon = topic.icon;
  return (
    <div className="rounded-2xl border border-card-border bg-card p-4 flex gap-3">
      <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
        <Icon className="w-5 h-5" />
      </span>
      <div className="min-w-0">
        <div className="font-light">{topic.title}</div>
        <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">{topic.text}</p>
      </div>
    </div>
  );
}
