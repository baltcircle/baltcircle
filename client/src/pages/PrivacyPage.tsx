import { Link } from "wouter";
import { ArrowLeft, ShieldCheck } from "lucide-react";

// MVP privacy policy. Operator legal details are placeholders until the legal
// entity / ИП is finalized — see the note at the bottom. The text below is
// intentionally concrete about what data is collected so it is usable for an
// MVP launch, but must be reviewed by a lawyer and have operator details filled
// in before public launch.
export function PrivacyPage() {
  return (
    <div className="min-h-full bg-background" data-testid="page-privacy">
      <div className="mx-auto max-w-2xl px-5 pt-6 pb-16">
        <header className="mb-6 flex items-center gap-3">
          <Link
            href="/"
            data-testid="link-privacy-back"
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
              <ShieldCheck className="w-5 h-5" /> Политика конфиденциальности
            </h1>
          </div>
        </header>

        <div className="prose prose-sm dark:prose-invert max-w-none space-y-5 text-sm leading-relaxed">
          <p className="text-muted-foreground">Редакция MVP. Дата вступления в силу: при запуске сервиса.</p>

          <section>
            <h2 className="font-display text-lg font-light">1. Общие положения</h2>
            <p>
              Настоящая Политика конфиденциальности описывает, какие персональные данные
              обрабатывает сервис аренды велосипедов BaltCircle (далее — «Сервис»), с какой
              целью и на каком основании. Используя Сервис, вы соглашаетесь с условиями
              настоящей Политики.
            </p>
          </section>

          <section>
            <h2 className="font-display text-lg font-light">2. Оператор персональных данных</h2>
            <p>
              Оператором персональных данных является [НАИМЕНОВАНИЕ ОПЕРАТОРА — ООО/ИП «___»,
              ОГРН/ОГРНИП ___, адрес ___, e-mail для обращений ___]. Данные оператора будут
              уточнены до публичного запуска Сервиса.
            </p>
          </section>

          <section>
            <h2 className="font-display text-lg font-light">3. Какие данные мы собираем</h2>
            <ul>
              <li><strong>Имя</strong>, которое вы указываете при регистрации.</li>
              <li><strong>Номер телефона</strong> для подтверждения по SMS и связи с вами.</li>
              <li><strong>Данные сессии</strong> (cookie, идентификатор сессии) для распознавания вас на устройстве.</li>
              <li><strong>Данные о поездках</strong>: время, длительность, маршрут (GPS-трек), стоимость, выбранный тариф.</li>
              <li><strong>Данные об аренде</strong> и используемом велосипеде.</li>
              <li><strong>Метаданные способов оплаты</strong> (например, маскированный номер карты) — при подключении оплаты в будущих версиях. Полные платёжные реквизиты Сервисом не хранятся.</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-lg font-light">4. Цели обработки</h2>
            <ul>
              <li>Регистрация и подтверждение номера телефона.</li>
              <li>Предоставление услуги аренды и контроль поездок.</li>
              <li>Расчёт стоимости поездок и проведение платежей.</li>
              <li>Обеспечение безопасности, предотвращение мошенничества и нарушений.</li>
              <li>Связь с вами по вопросам, связанным с использованием Сервиса.</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-lg font-light">5. Правовые основания</h2>
            <p>
              Обработка осуществляется на основании вашего согласия, а также для исполнения
              договора оказания услуг аренды и в соответствии с Федеральным законом
              № 152-ФЗ «О персональных данных».
            </p>
          </section>

          <section>
            <h2 className="font-display text-lg font-light">6. Хранение и защита</h2>
            <p>
              Коды подтверждения из SMS хранятся только в виде криптографического хэша и
              действуют ограниченное время. Мы применяем организационные и технические меры
              для защиты данных от несанкционированного доступа. Данные хранятся не дольше,
              чем необходимо для указанных целей или предусмотрено законом.
            </p>
          </section>

          <section>
            <h2 className="font-display text-lg font-light">7. Передача третьим лицам</h2>
            <p>
              Для отправки SMS с кодом подтверждения номер телефона передаётся
              SMS-провайдеру (SMS.RU). Иным третьим лицам данные передаются только в случаях,
              предусмотренных законом.
            </p>
          </section>

          <section>
            <h2 className="font-display text-lg font-light">8. Ваши права</h2>
            <p>
              Вы вправе запросить доступ к своим персональным данным, их уточнение,
              блокирование или удаление, а также отозвать согласие на обработку, направив
              обращение оператору по контактам, указанным выше.
            </p>
          </section>

          <p className="text-xs text-muted-foreground border-t border-card-border pt-4">
            Примечание для запуска: перед публичным запуском необходимо заменить
            placeholder-данные оператора (наименование, ОГРН/ОГРНИП, адрес, контактный e-mail)
            на реальные реквизиты юридического лица или ИП и провести юридическую проверку
            текста.
          </p>
        </div>
      </div>
    </div>
  );
}
