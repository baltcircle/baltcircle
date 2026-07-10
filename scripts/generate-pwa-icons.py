"""Генератор PWA-иконок TakeRide.

Рисуем ту же велосипедную иконку что и в favicon (32x32 SVG),
только в бо́льших размерах и в PNG для манифеста.

- icon-192.png       : стандартный размер для home screen
- icon-512.png       : для больших дисплеев и splash-screen
- icon-maskable-512  : с 20% safe-area отступом для Android adaptive icons
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "client" / "public"
BG = (29, 106, 133)      # #1d6a85 — primary teal
FG = (255, 255, 255)     # белый штрих на плашке


def draw_bike(draw: ImageDraw.ImageDraw, cx: int, cy: int, scale: float) -> None:
    """Стилизованный велосипед: два колеса + рама + седло/руль.

    (cx, cy) — центр изображения; scale — множитель размера от базового 32px.
    """
    s = scale
    stroke = max(2, int(3 * s))
    wheel_r = int(6 * s)
    # позиции колёс
    left_x, right_x = cx - int(8 * s), cx + int(8 * s)
    wheel_y = cy + int(6 * s)
    # два колеса — окружности с обводкой
    for wx in (left_x, right_x):
        draw.ellipse(
            [wx - wheel_r, wheel_y - wheel_r, wx + wheel_r, wheel_y + wheel_r],
            outline=FG,
            width=stroke,
        )
    # рама: треугольник от левого колеса вверх и вправо к рулю
    top_y = cy - int(6 * s)
    top_x = cx + int(2 * s)
    frame_pts = [
        (left_x, wheel_y),
        (top_x, top_y),
        (right_x, wheel_y),
    ]
    draw.line(frame_pts + [frame_pts[0]], fill=FG, width=stroke, joint="curve")
    # руль — короткая горизонтальная перекладина сверху справа
    handlebar_left = right_x - int(2 * s)
    handlebar_right = right_x + int(2 * s)
    handlebar_y = top_y
    draw.line(
        [(handlebar_left, handlebar_y), (handlebar_right, handlebar_y)],
        fill=FG,
        width=stroke,
    )
    # седло — короткая перекладина в верхней части рамы над левым колесом
    saddle_y = top_y + int(1 * s)
    saddle_left = left_x + int(2 * s)
    saddle_right = left_x + int(6 * s)
    draw.line(
        [(saddle_left, saddle_y), (saddle_right, saddle_y)],
        fill=FG,
        width=stroke,
    )


def make_icon(size: int, safe_area_pct: float = 0.0) -> Image.Image:
    """Создать PNG-иконку размера size×size.

    safe_area_pct — процент отступа для maskable-иконок (Android adaptive).
    Например 0.2 = 20% отступ со всех сторон, велосипед рисуется в центре 60%.
    """
    img = Image.new("RGBA", (size, size), BG + (255,))
    draw = ImageDraw.Draw(img)
    # scale — производный размер: базовый рисунок был в 32px, безопасная зона считается от size
    safe_size = size * (1.0 - 2 * safe_area_pct)
    scale = safe_size / 32.0
    draw_bike(draw, size // 2, size // 2, scale)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    make_icon(192).save(OUT / "icon-192.png", "PNG", optimize=True)
    make_icon(512).save(OUT / "icon-512.png", "PNG", optimize=True)
    # maskable — с 20% отступом внутри, чтобы Android при обрезке круга/сквиркла
    # не отрезал велосипед
    make_icon(512, safe_area_pct=0.2).save(
        OUT / "icon-maskable-512.png", "PNG", optimize=True
    )
    print("PWA icons generated:", *sorted(OUT.glob("icon-*.png")), sep="\n  ")


if __name__ == "__main__":
    main()
