// GPS-фильтрация и сглаживание для активной поездки.
//
// Сырой navigator.geolocation.watchPosition даёт шумный поток: точность прыгает,
// в стоячем положении точка «дрожит» на ±10-20 м, изредка прилетает выброс
// (телепорт) с другого конца города. Всё это уродует и голубую точку, и линию
// трека. Модуль чистый (без DOM/браузерных API) — поэтому легко тестируется.
//
// Пайплайн push(fix):
//   1) отбрасываем точки с плохой accuracy (хуже порога) — кроме первой;
//   2) отбрасываем «телепорты»: физически невозможная скорость между точками;
//   3) сглаживаем EMA c адаптивным alpha — стоим → сильное сглаживание (гасим
//      джиттер), реально едем → alpha→1 (мгновенная реакция, без «резины»).

export interface RawFix {
  lat: number;
  lng: number;
  /** Радиус погрешности в метрах (navigator coords.accuracy). */
  accuracy: number;
  /** Курс от GPS в градусах (0=север) или null, если недоступен. */
  heading?: number | null;
  /** Момент фиксации, мс (Date.now / position.timestamp). */
  timestamp: number;
}

export interface SmoothedFix {
  lat: number;
  lng: number;
  accuracy: number;
  /** Итоговый курс: GPS-heading, иначе рассчитанный по вектору движения, иначе null. */
  heading: number | null;
  timestamp: number;
}

export interface GeoFilterOptions {
  /** Порог accuracy (м): точки хуже отбрасываются. По умолчанию 50 м —
   *  городской GPS велосипедиста обычно 5-30 м; 50+ это уже «плавает». */
  maxAccuracyM?: number;
  /** Максимальная правдоподобная скорость (м/с) между двумя точками.
   *  60 км/ч ≈ 16.7 м/с — заведомо выше велосипеда, всё что выше = выброс. */
  maxSpeedMps?: number;
  /** Базовый коэффициент EMA (0..1) для медленных/шумовых перемещений.
   *  Меньше → сильнее сглаживание. */
  baseAlpha?: number;
  /** Сколько подряд выбросов терпим, прежде чем принять точку принудительно
   *  (GPS реально перескочил — тоннель, мост, потеря сигнала). */
  maxConsecutiveRejects?: number;
  /** Ниже этого смещения (м) курс по вектору движения не пересчитываем —
   *  на месте вектор случаен. */
  minHeadingMoveM?: number;
}

const DEFAULTS: Required<GeoFilterOptions> = {
  maxAccuracyM: 50,
  maxSpeedMps: 16.7,
  baseAlpha: 0.3,
  maxConsecutiveRejects: 3,
  minHeadingMoveM: 3,
};

export interface GeoFilter {
  /** Обработать сырую точку. Вернёт сглаженную либо null, если точка отброшена. */
  push(fix: RawFix): SmoothedFix | null;
  /** Сбросить состояние (новая поездка). */
  reset(): void;
}

export function createGeoFilter(options: GeoFilterOptions = {}): GeoFilter {
  const opts = { ...DEFAULTS, ...options };
  let last: SmoothedFix | null = null;
  let rejects = 0;

  const reset = () => { last = null; rejects = 0; };

  const push = (fix: RawFix): SmoothedFix | null => {
    const rawHeading = fix.heading != null && Number.isFinite(fix.heading) ? fix.heading : null;

    // Первая точка — принимаем как есть (иначе не с чего начать; дот появится сразу).
    if (!last) {
      last = { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, heading: rawHeading, timestamp: fix.timestamp };
      rejects = 0;
      return last;
    }

    // (1) Фильтр точности — но не блокируем навсегда: если пошёл поток мусора,
    // накопление reject'ов ниже всё равно пробьёт «затор».
    const badAccuracy = Number.isFinite(fix.accuracy) && fix.accuracy > opts.maxAccuracyM;

    // (2) Телепорт: скорость между последней принятой и этой точкой.
    const dm = haversineM(last.lat, last.lng, fix.lat, fix.lng);
    const dtSec = Math.max((fix.timestamp - last.timestamp) / 1000, 0.001);
    const speed = dm / dtSec;
    const teleport = speed > opts.maxSpeedMps;

    if (badAccuracy || teleport) {
      rejects += 1;
      // Затор: несколько выбросов подряд — значит GPS реально ушёл (или сигнал
      // восстановился в новой точке). Принимаем принудительно и перезапускаем EMA,
      // чтобы фильтр не «залипал» на старом месте.
      if (rejects >= opts.maxConsecutiveRejects) {
        last = { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, heading: rawHeading ?? last.heading, timestamp: fix.timestamp };
        rejects = 0;
        return last;
      }
      return null;
    }

    rejects = 0;

    // (3) Адаптивное EMA. snr = смещение / точность: движение много больше
    // радиуса погрешности почти наверняка реальное → alpha→1 (мгновенно, без
    // «резинового» отставания). Мелкие шевеления в пределах точности — шум →
    // baseAlpha (сильное сглаживание, гасим дрожание точки на месте).
    const snr = dm / Math.max(fix.accuracy || 1, 1);
    const alpha = snr >= 2 ? 1 : opts.baseAlpha + (1 - opts.baseAlpha) * (snr / 2);

    const lat = last.lat + alpha * (fix.lat - last.lat);
    const lng = last.lng + alpha * (fix.lng - last.lng);

    // Курс: доверяем GPS-heading; иначе считаем по вектору реального перемещения
    // (только если сдвинулись заметно — на месте вектор бессмысленен). Иначе
    // держим прошлый курс, чтобы стрелка/сектор не крутились вхолостую.
    let heading = last.heading;
    if (rawHeading !== null) {
      heading = rawHeading;
    } else if (dm >= opts.minHeadingMoveM) {
      heading = bearingDeg(last.lat, last.lng, lat, lng);
    }

    last = { lat, lng, accuracy: fix.accuracy, heading, timestamp: fix.timestamp };
    return last;
  };

  return { push, reset };
}

// ── Сегментация трека по разрывам ───────────────────────────────────────────
// Мобильный браузер приостанавливает JS/watchPosition, когда вкладка уходит в
// фон (блокировка экрана, сворачивание — особенно iOS Safari). Точки в это время
// не пишутся, и наивная линия соединяет «где вышел» и «где вернулся» прямым
// отрезком через весь незаписанный участок. То же бывает при потере GPS-сигнала.
// Решение: рвать линию на отдельные сегменты там, где между двумя соседними
// принятыми точками прошёл слишком большой интервал (или пришёл явный маркер
// разрыва от visibilitychange), и сглаживать каждый сегмент по отдельности.

/** Порог разрыва трека (мс). Больший интервал между соседними точками = пауза
 *  трекинга. 45 с заведомо выше нормального шага (троттл трекера 3 с, а
 *  watchPosition отдаёт точку раз в 5-15 с даже на месте), но достаточно мало,
 *  чтобы уверенно поймать уход в фон или потерю сигнала. */
export const TRACK_GAP_MS = 45_000;

export interface TrackFix {
  lng: number;
  lat: number;
  /** Момент точки, мс (server-side t из ride_points). */
  t: number;
  /** Явный маркер разрыва перед этой точкой (например, от visibilitychange). */
  gapBefore?: boolean;
}

/**
 * Разбивает последовательность точек трека на непрерывные сегменты. Разрыв
 * объявляется, если между соседними точками прошло больше gapMs ИЛИ у точки
 * выставлен gapBefore. Порядок точек сохраняется; сглаживание (Дуглас-Пекер +
 * Catmull-Rom) вызывающий код применяет к каждому сегменту отдельно — иначе
 * сгладился бы и ложный переход через разрыв.
 */
export function segmentTrack(points: TrackFix[], gapMs: number = TRACK_GAP_MS): TrackFix[][] {
  const segments: TrackFix[][] = [];
  let current: TrackFix[] = [];
  for (const p of points) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const broken = p.gapBefore === true || p.t - prev.t > gapMs;
      if (broken) {
        segments.push(current);
        current = [];
      }
    }
    current.push(p);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Расстояние между двумя точками по формуле гаверсинусов, метры. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Начальный азимут (курс) из точки 1 в точку 2, градусы 0..360 (0 = север). */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Перпендикулярное расстояние точки p до прямой a-b (в тех же единицах, что вход). */
function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / len2;
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Упрощение полилинии Дугласа-Пекера. Убирает избыточные точки на почти прямых
 * участках, сохраняя форму. epsilon — в единицах координат (для [lng,lat] это
 * градусы; 1e-5 ≈ 1.1 м по широте на этих широтах). Не искажает геометрию —
 * только выкидывает точки, отклонение которых от хорды меньше epsilon.
 */
export function douglasPeucker(points: [number, number][], epsilon: number): [number, number][] {
  if (points.length <= 2) return points.slice();
  let maxDist = 0;
  let idx = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpDist(points[i], points[0], points[end]);
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, idx + 1), epsilon);
    const right = douglasPeucker(points.slice(idx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [points[0], points[end]];
}
