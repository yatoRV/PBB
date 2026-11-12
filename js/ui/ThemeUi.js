// Port of vn.lichdilam.ThemeUi (APK 4.5) for DOM screens.
// Semantic bindings recolor existing views without rebuilding forms or losing selection: on the web a colour role
// binds an element to the palette's CSS custom property ("app.text" → var(--app-text), js/shell/theme.js), so an
// appearance change recolours every open screen and dialog at once — what ThemeUi.visit does on Android.
// DialogBuilder is AlertDialog.Builder (js/platform/widget.js) with the light/dark dialog style of the palette.
import { AlertDialog } from '../platform/widget.js';
import { ThemeSettings } from '../core/ThemeSettings.js';
import { cssColor, cssName } from '../shell/theme.js';

const BG = 0xFF101522 | 0, PANEL = 0xFF1C2334 | 0, TEXT = 0xFFF1F3FB | 0, MUTED = 0xFFA8B2CA | 0, ACCENT = 0xFFB8C7FF | 0, ON_ACCENT = 0xFF1F2D52 | 0, WARNING = 0xFFE6C189 | 0, SUCCESS = 0xFFA6DCC2 | 0, DANGER = 0xFFFFB8B2 | 0;
const roles = new Map([[BG, 'app.background'], [PANEL, 'app.panel'], [TEXT, 'app.text'], [MUTED, 'app.muted'], [ACCENT, 'app.accent'], [ON_ACCENT, 'app.onAccent'], [0xFF253157 | 0, 'app.onAccent'], [WARNING, 'app.warning'], [0xFFFFC586 | 0, 'app.warning'], [SUCCESS, 'app.success'], [DANGER, 'app.danger'], [0xFF77849E | 0, 'app.muted'], [0xFF74829D | 0, 'calendar.horizontal'], [0xFF292E41 | 0, 'calendar.background']]);
const colorOf = (roleOrKey) => { const key = typeof roleOrKey === 'string' ? roleOrKey : ThemeUi.key(roleOrKey); return key == null ? cssColor(roleOrKey) : 'var(' + cssName(key) + ')'; };

export class ThemeUi {
  static BG = BG; static PANEL = PANEL; static TEXT = TEXT; static MUTED = MUTED; static ACCENT = ACCENT; static ON_ACCENT = ON_ACCENT; static WARNING = WARNING; static SUCCESS = SUCCESS; static DANGER = DANGER;
  static palette(c) { return c != null && typeof c.palette === 'function' ? c.palette() : new ThemeSettings(c).current(); }
  static key(color) { return roles.get(color | 0) ?? null; }
  static color(c, key) { return ThemeUi.palette(c).color(key); }
  /** Text colour of an element: a role constant (BG…DANGER) or a palette key ("calendar.month"). */
  static text(view, roleOrKey) { view.style.color = colorOf(roleOrKey); }
  /** Hint (placeholder) colour: always app.muted (css/app.css ::placeholder). */
  static hint(view, ignored) { view.classList.add('hinted'); } // eslint-disable-line no-unused-vars
  /** Background of a role or palette key with a corner radius in dp (= CSS px). */
  static bg(view, roleOrKey, radius) { view.style.background = colorOf(roleOrKey); if (radius != null) view.style.borderRadius = radius + 'px'; }
  static solid(view, role) { ThemeUi.bg(view, role, 0); }
  static border(view, key, width) { view.style.border = width + 'px solid ' + colorOf(key); }
  /** CSS colour value bound to a role or key (for canvas-free inline styles). */
  static css(roleOrKey) { return colorOf(roleOrKey); }

  static DialogBuilder = class DialogBuilder extends AlertDialog.Builder {
    constructor(context) { super(context, ThemeUi.palette(context).light ? 'light' : 'dark'); this.owner = context; }
    create() { const dialog = super.create(); if (this.owner != null && typeof this.owner.watch === 'function') this.owner.watch(dialog); return dialog; }
    show() { const d = this.create(); d.show(); return d; }
  };
}
