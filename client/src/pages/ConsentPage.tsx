import { Link } from "wouter";
import { ArrowLeft, FileCheck } from "lucide-react";

// MVP consent to personal data processing. Like the privacy policy, operator
// details are placeholders until the legal entity / ИП is finalized.
export function ConsentPage() {
  return (
    <div className="min-h-full bg-background" data-testid="page-consent">
      <div className="mx-auto max-w-2xl px-5 pt-6 pb-16">
        <header className="mb-6 flex items-center gap-3">
          <Link
            href="/"
            data-testid="link-consent-back"
            aria-label="На главную"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground hover-elevate shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
              BaltCircle
            </div>
            <h1 className="font-display text-2xl font-light leading-tight flex items-center gap-2">
              <FileCheck className="w-5 h-5" /> Согласие на обработку персональных данных
            </h1>
          </div>
        </header>

        <div className="prose prose-sm dark:prose-invert max-w-none space-y-5 text-sm leading-relaxed">
          <p className="text-muted-foreground">Редакция MVP.</p>

          <p>
            Регистрируясь в сервисе аренды велосипедов BaltCircle (далее — «Сервис») и
            проставляя отметку о согласии, я, субъект персональных данных, свободно, своей
            волей и в своём интересе даю согласие оператору [НАИМЕНОВАНИЕ ОПЕРАТОРА —
            ООО/ИП «___», адрес ___] (далее — «Оператор») на обработку моих персональных
            данных на следующих условиях.
          </p>

          <section>
            <h2 className="font-display text-lg font-light">1. Перечень данных</h2>
            <ul>
              <li>имя;</li>
              <li>номер мобильного телефона;</li>
              <li>идентификатор сессии (cookie);</li>
              <li>данные о поездках и аренде, включая GPS-трек, время, длительность и стоимость;</li>
              <li>метаданные способов оплаты (при подключении оплаты в будущих версиях).</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-lg font-light">2. Цели обработки</h2>
            <p>
              Регистрация и подтверждение номера телефона по SMS, предоставление услуги
              аренды, расчёт и проведение платежей, обеспечение безопасности и связь со мной
              по вопросам использования Сервиса.
            </p>
          </section>

          <section>
            <h2 className="font-display text-lg font-light">3. Действия с данными</h2>
            <p>
              Сбор, запись, систематизация, накопление, хранение, уточнение, использование,
              передача SMS-провайдеру для отправки кода подтверждения, обезличивание,
              блокирование, удаление и уничтожение — как с использованием средств
              автоматизации, так и без них.
            </p>
          </section>

          <section>
            <h2 className="font-display text-lg font-light">4. Срок и отзыв согласия</h2>
            <p>
              Согласие действует до достижения целей обработки либо до его отзыва. Я вправе
              отозвать согласие, направив письменное обращение Оператору по указанным
              контактам; после отзыва Оператор прекращает обработку, если иное не
              предусмотрено законом.
            </p>
          </section>

          <p>
            Я подтверждаю, что ознакомлен(а) с{" "}
            <Link href="/privacy" className="underline hover:text-foreground" data-testid="link-consent-to-privacy">
              Политикой конфиденциальности
            </Link>{" "}
            и принимаю её условия.
          </p>

          <p className="text-xs text-muted-foreground border-t border-card-border pt-4">
            Примечание для запуска: перед публичным запуском замените placeholder-данные
            оператора на реальные реквизиты и проведите юридическую проверку текста согласия.
          </p>
        </div>
      </div>
    </div>
  );
}
