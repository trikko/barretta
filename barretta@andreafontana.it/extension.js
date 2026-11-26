// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Andrea Fontana
//
// Barra: barra delle applicazioni verticale per GNOME Shell 50/51.
//
// Regole di progetto:
// - zero lavoro a riposo: nessun timer, solo segnali, aggiornamenti raggruppati
//   in un unico passaggio prima del ridisegno;
// - nessuna modifica agli interni della shell (niente monkey-patching);
// - ogni segnale è legato a `this` con connectObject, così disable() pulisce tutto.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Tray} from './tray.js';

const SPACING = 2;

// Dimensioni della barra, a scatti: [lato della piastrella, lato dell'icona].
// Si sceglie dalla finestrella del tasto destro; tutto il resto ne deriva.
const SIZES = [[36, 21], [40, 24], [44, 26], [48, 29], [52, 31]];
let ITEM = 44;
let ICON = 26;
let BAR_WIDTH = 52;
let SLOT = ITEM + SPACING;    // altezza di un'icona nella lista, spaziatura compresa
let TOOL_HEIGHT = 34;
let SCROLL_STEP = SLOT;       // un'icona per scatto di rotella

// Lato della barra: 'left', 'right' o 'bottom'. In basso tutto si gira.
function isHorizontal(side) {
    return side === 'bottom';
}

// Da che parte si aprono menu e anteprime rispetto alla barra.
function popupSide(side) {
    return side === 'right' ? St.Side.RIGHT : side === 'bottom' ? St.Side.BOTTOM : St.Side.LEFT;
}

function applySize(index) {
    const [tile, icon] = SIZES[Math.max(0, Math.min(SIZES.length - 1, index))];
    ITEM = tile;
    ICON = icon;
    BAR_WIDTH = tile + 8;
    SLOT = tile + SPACING;
    TOOL_HEIGHT = Math.round(tile * 0.77);
    SCROLL_STEP = SLOT;
}
const HIGHLIGHT_OPACITY = 170;
const CLOSED_OPACITY = 150;
const GHOST_OPACITY = 95;     // icona trascinata: circa 37%
const DASH_INSET = 4;         // px tra il bordo della piastrella e il tratteggio
const DRAG_THRESHOLD = 6;     // px di movimento prima che un clic diventi trascinamento
const DROP_LINE_WIDTH = 36;
const DROP_LINE_HEIGHT = 3;
const TRAY_BUTTON = 24;        // lato del pulsante di un'icona di sistema
const TRAY_ICON = 16;
const TRAY_MAX_CHOICES = 6;    // nella finestrella: 1…6 oppure tutte
const PROGRESS_LINE = 2.5;    // spessore dell'anello di avanzamento
const PROGRESS_INSET = 3;     // px tra il bordo della piastrella e l'anello
const DND_HOVER_DELAY = 500;         // ms d'attesa se l'app è aperta (un quarto di giro)
const DND_HOVER_DELAY_CLOSED = 1000; // ms se va aperta (mezzo giro): aprirla costa di più
const DND_LEAVE_GRACE = 300;   // ms fuori dall'icona (e dalle anteprime) prima di annullare
const DND_WATCH_INTERVAL = 100; // ms: solo durante un trascinamento, si è ancora sopra l'icona?
const DND_FLASH = 220;          // ms del lampo sulla piastrella a conto finito
const DND_SEGMENT = 0.36;       // lunghezza di ognuno dei 4 tratti, in frazione del loro quarto
const SPARE_MAX = 40;           // icone staccate tenute da parte al massimo
const EDGE_SIZE = 2;            // px della striscia sul bordo che fa rientrare la barra nascosta
const AUTOHIDE_DELAY = 400;     // ms dopo che il mouse esce, prima di nascondere
const AUTOHIDE_ANIMATION = 180;   // ms fermi su un'icona con un file trascinato
const ARROW_PAGE_DELAY = 500;  // ms fermi su una freccia, trascinando, per scorrere di una pagina
const FOLLOW_TAU = 60;      // ms: quanto la lista "insegue" la rotella (più basso = più pronta)
const TOUCHPAD_SCALE = 10;  // il trackpad manda unità da 10 px
const ARROW_REPEAT_DELAY = 300;
const ARROW_REPEAT = 90;
const PREVIEW_DELAY = 400;
const PREVIEW_HIDE_DELAY = 250;
const WS_SWITCH_INTERVAL = 250; // ms minimi tra due cambi di spazio di lavoro
const PREVIEW_SUPPRESS = 400;  // ms senza anteprime dopo uno scorrimento
const PREVIEW_W = 160;
const PREVIEW_H = 100;

// Ordine stabile delle finestre: prima per monitor, poi per ordine di creazione.
// Scorrere le finestre segue sempre lo stesso giro: finisce quelle di un
// monitor prima di passare al successivo, e non rimbalza tra le due più recenti
// come farebbe un ordine "usate di recente".
function byMonitorThenSequence(a, b) {
    return a.get_monitor() - b.get_monitor() ||
        a.get_stable_sequence() - b.get_stable_sequence();
}

// Una finestra ancora gestita (non chiusa nel frattempo).
function alive(window) {
    return !!window && !!window.get_compositor_private() && window.get_workspace() !== null;
}

// Main.activateWindow fallisce su una finestra appena chiusa: si controlla prima.
function activate(window) {
    if (alive(window))
        Main.activateWindow(window);
}

function queryInfo(file, attributes) {
    return new Promise(resolve => {
        file.query_info_async(attributes, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, (f, res) => {
            try {
                resolve(f.query_info_finish(res));
            } catch {
                resolve(null);
            }
        });
    });
}

function mostRecent(windows) {
    return windows.reduce((best, w) =>
        !best || w.get_user_time() > best.get_user_time() ? w : best, null);
}

function isUrgent(windows) {
    return windows.some(w => w.demands_attention || w.urgent);
}

// Numeri su una cifra: oltre il 9 si scrive "+".
function short(n) {
    return n > 9 ? '+' : `${n}`;
}

function setClass(actor, name, on) {
    if (on)
        actor.add_style_class_name(name);
    else
        actor.remove_style_class_name(name);
}

// ---- ricerca ----

// Minuscole e senza accenti: "Città" si trova scrivendo "citta".
function normalize(text) {
    return (text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// Tutto ciò che si può cercare di una finestra: titolo, app (nome, nome
// generico, descrizione, parole chiave, id), classe della finestra e dove sta.
// Si ricalcola solo se cambiano titolo, schermo o desktop della finestra.
const haystackCache = new WeakMap();

function windowHaystack(window, app) {
    const stamp = `${window.get_title()}|${window.get_monitor()}|${window.get_workspace()?.index()}|${app?.get_id()}`;
    const cached = haystackCache.get(window);
    if (cached?.stamp === stamp)
        return cached.text;
    const text = computeHaystack(window, app);
    haystackCache.set(window, {stamp, text});
    return text;
}

function computeHaystack(window, app) {
    const info = app?.get_app_info();
    const parts = [
        window.get_title(),
        window.get_wm_class(),
        app?.get_name(),
        app?.get_id(),
        info?.get_generic_name?.(),
        info?.get_description?.(),
        ...(info?.get_keywords?.() ?? []),
        `screen ${window.get_monitor() + 1}`,
        _('screen %d').format(window.get_monitor() + 1),
    ];
    const workspace = window.get_workspace();
    if (workspace) {
        const n = workspace.index() + 1;
        parts.push(`desktop ${n}`, `workspace ${n}`, _('desktop %d').format(n));
    }
    return normalize(parts.filter(Boolean).join(' '));
}

// Tutte le parole cercate devono esserci, in qualsiasi ordine.
function windowMatches(window, app, tokens) {
    const haystack = windowHaystack(window, app);
    return tokens.every(t => haystack.includes(t));
}

// Documenti recenti di un'app, dall'elenco che GTK tiene per tutte le app
// (recently-used.xbel). Si legge solo all'apertura del menu.
const RECENT_MAX = 6;

const RECENT_FILE_MAX = 4 * 1024 * 1024;   // recently-used.xbel più grande: ignorato
const recentCache = {mtime: null, bookmarks: null};

// L'elenco GTK dei file recenti, letto senza bloccare la shell e riletto solo
// se il file è cambiato.
async function loadRecent() {
    const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']));
    const info = await queryInfo(file, 'standard::type,standard::size,time::modified');
    if (!info || info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > RECENT_FILE_MAX)
        return null;
    const mtime = info.get_modification_date_time()?.to_unix() ?? 0;
    if (recentCache.bookmarks && recentCache.mtime === mtime)
        return recentCache.bookmarks;
    const bytes = await new Promise(resolve => {
        file.load_contents_async(null, (f, res) => {
            try {
                resolve(f.load_contents_finish(res)[1]);
            } catch {
                resolve(null);
            }
        });
    });
    if (!bytes || bytes.length > RECENT_FILE_MAX)
        return null;
    const bookmarks = new GLib.BookmarkFile();
    try {
        bookmarks.load_from_data(bytes);
    } catch {
        return null;
    }
    recentCache.mtime = mtime;
    recentCache.bookmarks = bookmarks;
    return bookmarks;
}

// Documenti recenti di un'app: solo file locali (file://) che esistono ancora,
// i più recenti per primi. L'esistenza si controlla senza bloccare e solo fino
// a trovarne abbastanza.
async function recentFilesFor(app, max) {
    const bookmarks = await loadRecent();
    if (!bookmarks)
        return [];
    const id = app.get_id().replace(/\.desktop$/, '');
    const exec = app.get_app_info()?.get_executable?.();
    const names = new Set([id, id.split('.').pop(), app.get_name(),
        exec ? GLib.path_get_basename(exec) : null].filter(Boolean).map(n => n.toLowerCase()));
    const candidates = [];
    for (const uri of bookmarks.get_uris()) {
        if (!uri.startsWith('file://'))
            continue;
        let apps = [];
        try {
            apps = bookmarks.get_applications(uri);
        } catch {
            continue;
        }
        if (!apps.some(a => names.has(a.toLowerCase())))
            continue;
        let when = 0;
        try {
            when = bookmarks.get_modified_date_time(uri)?.to_unix() ?? 0;
        } catch {}
        candidates.push([when, uri]);
    }
    candidates.sort((a, b) => b[0] - a[0]);
    const found = [];
    for (const [, uri] of candidates.slice(0, max * 3)) {
        const file = Gio.File.new_for_uri(uri);
        if (!file.is_native())
            continue;
        const info = await queryInfo(file, 'standard::type');
        if (info && info.get_file_type() === Gio.FileType.REGULAR)
            found.push(uri);
        if (found.length >= max)
            break;
    }
    return found;
}

// Dove si trova una finestra rispetto a una barra, in parole.
function placeOf(window, monitorIndex) {
    if (window.get_monitor() !== monitorIndex)
        return _('On screen %d').format(window.get_monitor() + 1);
    const workspace = window.get_workspace();
    return workspace ? _('On desktop %d').format(workspace.index() + 1) : _('Elsewhere');
}

// Raggruppa le finestre "altrove" per posto, mantenendo l'ordine.
function groupByPlace(windows, monitorIndex) {
    const groups = new Map();
    for (const w of windows) {
        const place = placeOf(w, monitorIndex);
        if (!groups.has(place))
            groups.set(place, []);
        groups.get(place).push(w);
    }
    return groups;
}

// Clic su un'app.
// - finestre qui: dà il fuoco, scorre, minimizza;
// - nessuna finestra qui ma aperta altrove: apre una nuova finestra QUI, invece
//   di portare su un altro schermo; per andare di là ci sono anteprima e menu;
// - non aperta: la avvia.
function activateApp(app, windows) {
    const focus = global.display.focus_window;

    if (windows.length === 0) {
        if (app.get_state() === Shell.AppState.STOPPED || !app.can_open_new_window())
            app.activate();
        else
            app.open_new_window(-1);
        return;
    }

    const index = windows.indexOf(focus);
    if (index === -1)
        activate(mostRecent(windows));
    else if (windows.length === 1)
        focus.minimize();
    else
        activate(windows[(index + 1) % windows.length]);
}

// ---------------------------------------------------------------------------
// Contorni a "pista": l'anello di avanzamento delle icone e il conto alla
// rovescia del trascinamento, sulle icone e sulle anteprime.

// Contorno arrotondato a distanza m dal bordo, con angoli di raggio r, che
// parte dal centro del lato alto in senso orario. Restituisce la lunghezza.
function roundedOutline(cr, w, h, m, r) {
    cr.newPath();
    cr.moveTo(w / 2, m);
    cr.lineTo(w - m - r, m);
    cr.arc(w - m - r, m + r, r, -Math.PI / 2, 0);
    cr.lineTo(w - m, h - m - r);
    cr.arc(w - m - r, h - m - r, r, 0, Math.PI / 2);
    cr.lineTo(m + r, h - m);
    cr.arc(m + r, h - m - r, r, Math.PI / 2, Math.PI);
    cr.lineTo(m, m + r);
    cr.arc(m + r, m + r, r, Math.PI, 3 * Math.PI / 2);
    cr.lineTo(w / 2, m);
    return 2 * (w + h - 4 * m) - 8 * r + 2 * Math.PI * r;
}

// Quattro tratti simmetrici sul contorno appena tracciato: con value da 0 a 1
// fanno `turns` quarti di giro. È il segnale "file sopra, aspetta".
function strokeCountdown(cr, length, value, turns, c) {
    const period = length / 4;
    const seg = period * DND_SEGMENT;
    const start = value * period * turns - seg;
    cr.setDash([seg, period - seg], ((-start % period) + period) % period);
    cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, 1);
    cr.stroke();
}

// Conto alla rovescia su un'anteprima: un contorno disegnato sopra di lei.
class CountdownRing {
    constructor() {
        this._value = null;
        this._timeline = null;
        this.actor = new St.DrawingArea({
            style_class: 'barra-countdown',
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this.actor.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            const line = PROGRESS_LINE;
            const length = roundedOutline(cr, w, h, 1 + line / 2, 4);
            cr.setLineWidth(line);
            cr.setLineCap(1);
            const c = area.get_theme_node().get_foreground_color();
            cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, 0.22);
            cr.strokePreserve();
            strokeCountdown(cr, length, this._value ?? 0, 1, c);
            cr.$dispose();
        });
    }

    start(duration) {
        this.stop();
        this._value = 0;
        this._timeline = new Clutter.Timeline({actor: this.actor, duration});
        this._timeline.connect('new-frame', tl => {
            this._value = tl.get_progress();
            this.actor.queue_repaint();
        });
        this._timeline.start();
        this.actor.show();
    }

    stop() {
        this._timeline?.stop();
        this._timeline = null;
        this._value = null;
        this.actor.hide();
    }
}

// ---------------------------------------------------------------------------
// Anteprime delle finestre: una sola per tutta l'estensione.

class Preview {
    constructor(owner) {
        this._owner = owner;
        this._showId = 0;
        this._hideId = 0;
        this.actor = new St.BoxLayout({
            style_class: 'barra-preview',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            visible: false,
        });
        this.actor.connect('enter-event', () => this._cancelHide());
        this.actor.connect('leave-event', () => this.scheduleHide());
        Main.layoutManager.addTopChrome(this.actor);
        this._closing = new Set();   // finestre chiuse dall'anteprima, in attesa
    }

    // Un'icona che sparisce: l'anteprima non deve più riferirsi a lei.
    forget(item) {
        if (this._item === item || this._pendingItem === item)
            this.hide();
    }

    // Mentre la lista scorre le icone passano sotto il mouse fermo: niente
    // anteprime finché non si ferma (e per un attimo dopo).
    suppress() {
        this._suppressUntil = GLib.get_monotonic_time() + PREVIEW_SUPPRESS * 1000;
        this.hide();
    }

    scheduleShow(item) {
        if (GLib.get_monotonic_time() < (this._suppressUntil ?? 0))
            return;
        this._cancelHide();
        if (this.actor.visible) {
            // Già aperta: si passa subito all'icona nuova, senza attesa.
            this._show(item);
            return;
        }
        this._cancelShow();
        this._pendingItem = item;
        this._showId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_DELAY, () => {
            this._showId = 0;
            this._pendingItem = null;
            this._show(item);
            return GLib.SOURCE_REMOVE;
        });
    }

    scheduleHide() {
        this._cancelShow();
        if (!this.actor.visible || this._hideId)
            return;
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_HIDE_DELAY, () => {
            this._hideId = 0;
            this.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Un file trascinato sopra un'app con più finestre: le anteprime subito,
    // senza attesa. Restano finché il file è sopra l'icona o sopra di loro.
    showForDrag(item) {
        this._cancelShow();
        this._cancelHide();
        this._show(item);
        this.dragItem = this.actor.visible ? item : null;
    }

    // La finestra appena portata davanti: bordo d'accento solo su di lei.
    markActive(entry) {
        for (const child of this.actor.get_children()) {
            if (child._window)
                setClass(child, 'active', child === entry);
        }
    }

    hide() {
        this._cancelShow();
        this._cancelHide();
        this.dragItem = null;
        this._item = null;
        this._pendingItem = null;
        this.actor.hide();
        // Le clone si distruggono subito: niente texture tenute in vita.
        this.actor.destroy_all_children();
        this._owner.nudgeAutohide?.();
    }

    _cancelShow() {
        if (this._showId)
            GLib.source_remove(this._showId);
        this._showId = 0;
    }

    _cancelHide() {
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = 0;
    }

    _addLabel(text) {
        this.actor.add_child(new St.Label({style_class: 'barra-preview-group', text}));
    }

    _show(item) {
        this._item = item;
        const here = item.windows.filter(w => alive(w) && !this._closing.has(w));
        const elsewhere = item.elsewhere.filter(w => alive(w) && !this._closing.has(w));
        if ((here.length === 0 && elsewhere.length === 0) || item.menuOpen) {
            this.hide();
            return;
        }
        this.actor.destroy_all_children();
        setClass(this.actor, 'light', this._owner.light);

        const focus = global.display.focus_window;

        // Le intestazioni compaiono solo se servono a distinguere qualcosa.
        if (here.length > 0) {
            if (elsewhere.length > 0)
                this._addLabel(_('On this screen'));
            for (const w of here)
                this.actor.add_child(this._makeEntry(w, w === focus));
        }
        for (const [place, windows] of groupByPlace(elsewhere, item.bar.monitorIndex)) {
            this._addLabel(place);
            for (const w of windows)
                this.actor.add_child(this._makeEntry(w, false));
        }

        this.actor.show();
        this._place(item);
    }

    _makeEntry(window, active) {
        // Il margine intorno lascia posto ai trattini del trascinamento, che
        // girano attorno all'anteprima senza coprirla.
        const box = new St.BoxLayout({
            style_class: 'barra-preview-content',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const source = window.get_compositor_private();
        if (source) {
            const [w, h] = source.get_size();
            const scale = Math.min(PREVIEW_W / Math.max(w, 1), PREVIEW_H / Math.max(h, 1), 1);
            box.add_child(new Clutter.Clone({
                source,
                width: Math.round(w * scale),
                height: Math.round(h * scale),
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        box.add_child(new St.Label({
            style_class: 'barra-preview-title',
            text: window.get_title() ?? '',
        }));

        // × in alto a destra, visibile al passaggio del mouse: chiude la finestra.
        const close = new St.Button({
            style_class: 'barra-preview-close',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });
        close.connect('clicked', () => this._closeWindow(window));
        const ring = new CountdownRing();
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout()});
        stack.add_child(box);
        stack.add_child(ring.actor);
        stack.add_child(close);

        const button = new St.Button({
            style_class: 'barra-preview-item',
            child: stack,
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE,
            track_hover: true,
        });
        setClass(button, 'active', active);
        // Un file trascinato sopra: dopo il conto, questa finestra davanti.
        button._window = window;
        button._ring = ring;
        button.connect('destroy', () => {
            button._gone = true;
            ring.stop();
        });
        button._delegate = {
            handleDragOver: source => {
                if (source === Main.xdndHandler)
                    this._owner.dndPreviewHover(button);
                return DND.DragMotionResult.CONTINUE;
            },
        };
        button.connect('notify::hover', () => {
            close.opacity = button.hover ? 255 : 0;
        });
        button.connect('clicked', (_b, mouseButton) => {
            // Clic centrale: chiude, come sulle schede del browser.
            if (mouseButton === Clutter.BUTTON_MIDDLE) {
                this._closeWindow(window);
                return;
            }
            activate(window);
            this.hide();
        });
        return button;
    }

    // Chiude una finestra dall'anteprima. L'anteprima si aggiorna quando la
    // finestra se ne va davvero (l'app può chiedere conferma).
    // Si collega al massimo una volta per finestra; il gestore si scollega da
    // solo quando la finestra se ne va, e tutti in destroy().
    _closeWindow(window) {
        if (!alive(window))
            return;
        window.delete(global.get_current_time());
        if (this._closing.has(window))
            return;
        this._closing.add(window);
        window.connectObject('unmanaged', () => {
            window.disconnectObject(this);
            this._closing.delete(window);
            const item = this._item;
            if (item && this.actor.visible)
                this._show(item);
        }, this);
    }

    _place(item) {
        const [ix, iy] = item.actor.get_transformed_position();
        const [iw, ih] = item.actor.get_transformed_size();
        const [, , natW, natH] = this.actor.get_preferred_size();
        const monitor = Main.layoutManager.monitors[item.bar.monitorIndex];
        const side = this._owner.side;

        let x, y;
        if (side === 'bottom') {
            // Sopra l'icona, centrata, dentro lo schermo.
            x = ix + iw / 2 - natW / 2;
            x = Math.max(monitor.x + 8, Math.min(x, monitor.x + monitor.width - natW - 8));
            y = iy - natH - 4;
        } else {
            x = side === 'right' ? ix - natW - 4 : ix + iw + 4;
            y = iy + ih / 2 - natH / 2;
            y = Math.max(monitor.y + 8, Math.min(y, monitor.y + monitor.height - natH - 8));
        }
        this.actor.set_position(Math.round(x), Math.round(y));
    }

    destroy() {
        this._cancelShow();
        this._cancelHide();
        for (const window of this._closing)
            window.disconnectObject(this);
        this._closing.clear();
        this.actor.destroy();
    }
}

// ---------------------------------------------------------------------------
// Badge delle notifiche: icone SVG già pronte (icons/badge-1..9, badge-plus),
// con il simbolo centrato al pixel sul render (vedi genera-badge.py).

class Badge {
    constructor(dir, params) {
        this._dir = dir;
        this._text = '';
        this.actor = new St.Icon({style_class: 'barra-badge', icon_size: 15, ...params});
    }

    setText(text) {
        if (text === this._text)
            return;
        this._text = text;
        const name = text === '+' ? 'plus' : text;
        this.actor.gicon = new Gio.FileIcon({file: this._dir.get_child(`badge-${name}.svg`)});
    }
}

// ---------------------------------------------------------------------------
// Un'icona della barra: un'app, con le sue finestre su questo monitor.
//
// Stati, leggibili a colpo d'occhio:
// - preferita chiusa: solo icona, un po' attenuata;
// - aperta qui: piastrella grigia dietro l'icona, icona piena;
// - attiva: piastrella nel colore d'accento.
// Indicatori:
// - pillola in basso "3 · 2": 3 finestre qui, 2 altrove (seconda cifra spenta);
// - badge rosso in alto a destra: notifiche dell'app.

class AppItem {
    constructor(bar, app) {
        this.bar = bar;
        this.app = app;
        this.windows = [];
        this.elsewhere = [];
        this.focused = false;
        this.menuOpen = false;
        this._menu = null;
        this._pillKey = '';

        // Niente x_expand/y_expand qui: in Clutter l'espansione dei figli risale
        // al genitore e la colonna distribuirebbe lo spazio libero tra le icone.
        // Nel BinLayout basta l'allineamento.
        const center = {
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        };
        this._tile = new St.Widget({style_class: 'barra-tile', width: ITEM, height: ITEM, ...center});
        this._highlight = new St.Widget({
            style_class: 'barra-highlight',
            width: ITEM,
            height: ITEM,
            opacity: HIGHLIGHT_OPACITY,
            visible: false,
            ...center,
        });
        this._icon = new St.Bin({child: app.create_icon_texture(ICON), ...center});
        // Contorno tratteggiato dell'icona che si sta trascinando.
        this._dashed = new St.DrawingArea({
            style_class: 'barra-dashed',
            width: ITEM,
            height: ITEM,
            visible: false,
            ...center,
        });
        this._dashed.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            const k = w / ITEM;   // scala HiDPI
            const c = area.get_theme_node().get_foreground_color();
            cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255);
            // Tratteggio stretto intorno all'icona: staccato di qualche pixel,
            // ben dentro la piastrella.
            cr.setLineWidth(1.25 * k);
            cr.setDash([3 * k, 2.5 * k], 0);
            const r = 6 * k, m = DASH_INSET * k;
            cr.newSubPath();
            cr.arc(w - m - r, m + r, r, -Math.PI / 2, 0);
            cr.arc(w - m - r, h - m - r, r, 0, Math.PI / 2);
            cr.arc(m + r, h - m - r, r, Math.PI / 2, Math.PI);
            cr.arc(m + r, m + r, r, Math.PI, 3 * Math.PI / 2);
            cr.closePath();
            cr.stroke();
            cr.$dispose();
        });
        // Nel BinLayout di GNOME 51 l'allineamento a un bordo vale solo per
        // gli elementi "espandibili". Lo sono solo pillola e badge: il
        // contenitore qui sotto e il pulsante bloccano l'espansione in modo
        // esplicito, così non risale fino alla colonna (che altrimenti
        // distribuirebbe lo spazio tra le icone).
        this._pill = new St.Label({
            style_class: 'barra-pill',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this._badge = new Badge(bar.ext.dir.get_child('icons'), {
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        // Verticale: largo quanto la barra, alto quanto la piastrella.
        // In basso: il contrario.
        const horizontal = isHorizontal(bar.ext.side);
        const [cw, ch] = horizontal ? [ITEM, BAR_WIDTH] : [BAR_WIDTH, ITEM];
        const content = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: cw,
            height: ch,
            x_expand: false,
            y_expand: false,
        });
        // Badge e pillola a 3 px dentro la piastrella, qualunque sia il lato.
        this._badge.actor.style = `margin-top: ${(ch - ITEM) / 2 + 3}px; margin-right: ${(cw - ITEM) / 2 + 3}px;`;
        this._pill.style = `margin-bottom: ${(ch - ITEM) / 2 + 3}px;`;
        content.add_child(this._tile);
        content.add_child(this._highlight);
        content.add_child(this._icon);
        content.add_child(this._dashed);
        // Avanzamento (download, copie…): un anello dentro la piastrella, lungo
        // il suo bordo, che si colora in senso orario partendo dall'alto. Non
        // tocca l'icona.
        this._progressValue = null;
        this._progress = new St.DrawingArea({
            style_class: 'barra-progress',
            width: ITEM,
            height: ITEM,
            visible: false,
            ...center,
        });
        this._progress.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            const k = w / ITEM;
            const line = PROGRESS_LINE * k;
            // Dentro la piastrella, staccato dal bordo di qualche pixel.
            const m = PROGRESS_INSET * k + line / 2;
            const r = 3 * k;
            const path = () => roundedOutline(cr, w, h, m, r);
            const length = path();
            cr.setLineWidth(line);
            cr.setLineCap(1);   // estremi arrotondati
            const c = area.get_theme_node().get_foreground_color();
            // Traccia: tutto il contorno, appena accennato.
            path();
            cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, 0.22);
            cr.stroke();
            // File trascinato sopra: quattro tratti simmetrici che fanno un
            // quarto di giro nel tempo d'attesa, per non confonderlo con un
            // download (che riempie l'anello).
            if (this._dndValue != null) {
                path();
                strokeCountdown(cr, length, this._dndValue, this._dndTurns, c);
                cr.$dispose();
                return;
            }
            // Avanzamento: il colore d'accento (bianco sull'app attiva).
            const done = Math.max(0, Math.min(1, this._progressValue ?? 0)) * length;
            if (done > 0) {
                path();
                cr.setDash([done, length], 0);
                cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, 1);
                cr.stroke();
            }
            cr.$dispose();
        });
        content.add_child(this._progress);
        content.add_child(this._pill);
        content.add_child(this._badge.actor);

        this.actor = new St.Button({
            style_class: 'barra-item',
            child: content,
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE | St.ButtonMask.SECONDARY,
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: cw,
            height: ch,
            x_expand: false,
            y_expand: false,
        });
        this.actor.connect('clicked', (_b, button) => this._onClicked(button));
        this.suppressClick = false;
        this.actor.connect('button-press-event', (_a, event) => {
            this.bar.dragPrepare(this, event);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('scroll-event', (_a, event) => this._onShiftScroll(event));
        // Trascinando un file da un'altra app: fermi mezzo secondo sopra l'icona,
        // la finestra dell'app viene in primo piano e ci si lascia il file.
        this.actor._delegate = this;
        this._dndHoverId = 0;
        // Con la tastiera: l'icona col fuoco resta in vista nella lista, e il
        // tasto Menu (o Maiusc+F10) apre il suo menu.
        this.actor.connect('key-focus-in', () => {
            if (this.actor.get_parent() === this.bar._list)
                this.bar._ensureVisible(this);
        });
        this.actor.connect('key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            const shift = event.get_state() & Clutter.ModifierType.SHIFT_MASK;
            if (key === Clutter.KEY_Menu || (shift && key === Clutter.KEY_F10)) {
                this._openMenu();
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_Escape) {
                global.stage.set_key_focus(null);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('notify::hover', () => {
            if (this.actor.hover)
                this.bar.ext.preview.scheduleShow(this);
            else
                this.bar.ext.preview.scheduleHide();
        });
    }

    // Durante il trascinamento l'icona resta al suo posto come "fantasma"
    // (grigia e trasparente) con un tratteggio intorno.
    setDragging(dragging) {
        this._dashed.visible = dragging;
        if (dragging)
            this._icon.add_effect_with_name('barra-ghost', new Clutter.DesaturateEffect({factor: 1}));
        else
            this._icon.remove_effect_by_name('barra-ghost');
        this._icon.opacity = dragging ? GHOST_OPACITY : (this.windows.length > 0 ? 255 : CLOSED_OPACITY);
        this._tile.visible = !dragging;
        this._highlight.visible = !dragging && this.focused;
    }

    update(windows, elsewhere, focusWindow, notifications, progress = null) {
        this._hasProgress = progress !== null;
        this._progress.visible = this._hasProgress || this._dndValue != null;
        if (progress !== null && progress !== this._progressValue) {
            this._progressValue = progress;
            this._progress.queue_repaint();
        }
        this.windows = windows;
        this.elsewhere = elsewhere;
        this.focused = windows.includes(focusWindow);
        this._highlight.visible = this.focused;
        if (this.focused !== this._wasFocused) {
            this._wasFocused = this.focused;
            this._progress.queue_repaint();
        }
        setClass(this.actor, 'focused', this.focused);
        setClass(this.actor, 'running', windows.length > 0);
        // Le preferite chiuse restano in secondo piano: le aperte risaltano da sole.
        this._icon.opacity = windows.length > 0 ? 255 : CLOSED_OPACITY;
        setClass(this.actor, 'urgent', !this.focused && isUrgent([...windows, ...elsewhere]));

        this._badge.actor.visible = notifications > 0;
        if (notifications > 0)
            this._badge.setText(short(notifications));

        // Pillola "qui · altrove", senza dire l'ovvio:
        // - nessuno zero: se una delle due parti è 0 si mostra solo l'altra;
        // - una sola finestra qui e niente altrove: nessuna pillola (la
        //   piastrella grigia dice già che l'app è aperta);
        // - solo altrove: il numero da solo, spento.
        const here = windows.length;
        const away = elsewhere.length;
        const key = `${short(here)}:${short(away)}`;
        if (key === this._pillKey)
            return;
        this._pillKey = key;
        let markup = null;
        if (here > 0 && away > 0)
            markup = `${short(here)}<span alpha="50%"> · ${short(away)}</span>`;
        else if (here > 1)
            markup = short(here);
        else if (here === 0 && away > 0)
            markup = `<span alpha="50%">${short(away)}</span>`;
        this._pill.visible = markup !== null;
        if (markup)
            this._pill.clutter_text.set_markup(markup);
    }

    _onClicked(button) {
        if (this.suppressClick)
            return;
        this.bar.ext.preview.hide();
        const state = Clutter.get_current_event()?.get_state() ?? 0;
        const ctrl = state & Clutter.ModifierType.CONTROL_MASK;
        const shift = state & Clutter.ModifierType.SHIFT_MASK;
        // Clic centrale o Ctrl+clic: una finestra nuova, qui.
        if (button === Clutter.BUTTON_MIDDLE || (button === Clutter.BUTTON_PRIMARY && ctrl))
            this.app.open_new_window(-1);
        else if (button === Clutter.BUTTON_SECONDARY)
            this._openMenu();
        // Maiusc+clic: porta qui la finestra che è su un altro schermo o desktop.
        else if (shift && this.elsewhere.length > 0)
            this._bringHere(mostRecent(this.elsewhere));
        else
            activateApp(this.app, this.windows);
    }

    handleDragOver(source) {
        if (source !== Main.xdndHandler)
            return DND.DragMotionResult.CONTINUE;
        this.bar.ext.dndHover(this);
        return DND.DragMotionResult.CONTINUE;
    }

    // Conto alla rovescia mentre un file trascinato resta sopra l'icona:
    // quattro tratti girano per `duration` ms, un quarto di giro ogni
    // DND_HOVER_DELAY. 0 li toglie.
    setDndCountdown(duration) {
        const on = duration > 0;
        this._dndTimeline?.stop();
        this._dndTimeline = null;
        this._dndValue = null;
        if (on) {
            this._dndValue = 0;
            this._dndTurns = duration / DND_HOVER_DELAY;
            this._dndTimeline = new Clutter.Timeline({actor: this._progress, duration});
            this._dndTimeline.connect('new-frame', tl => {
                this._dndValue = tl.get_progress();
                this._progress.queue_repaint();
            });
            this._dndTimeline.start();
        }
        this._progress.visible = !!this._hasProgress || this._dndValue !== null;
        this._progress.queue_repaint();
    }

    // Lampo d'accento sulla piastrella: il conto è finito.
    flash() {
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this.actor.add_style_class_name('dnd-ready');
        this._flashId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DND_FLASH, () => {
            this._flashId = 0;
            this.actor.remove_style_class_name('dnd-ready');
            return GLib.SOURCE_REMOVE;
        });
    }

    _bringHere(window) {
        if (!alive(window))
            return;
        if (window.get_monitor() !== this.bar.monitorIndex)
            window.move_to_monitor(this.bar.monitorIndex);
        const workspace = global.workspace_manager.get_active_workspace();
        if (!window.located_on_workspace(workspace))
            window.change_workspace(workspace);
        activate(window);
    }

    // Maiusc+rotella sull'icona: scorre le finestre di questa app (la rotella
    // semplice scorre la lista). Con Maiusc alcuni sistemi mandano lo
    // scorrimento in orizzontale: vanno bene entrambi.
    _onShiftScroll(event) {
        if (!(event.get_state() & Clutter.ModifierType.SHIFT_MASK) || this.windows.length === 0)
            return Clutter.EVENT_PROPAGATE;
        let step = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            step = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            step = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
                return Clutter.EVENT_STOP;
            const [dx, dy] = event.get_scroll_delta();
            this._shiftScroll = (this._shiftScroll ?? 0) + (Math.abs(dx) > Math.abs(dy) ? dx : dy);
            if (Math.abs(this._shiftScroll) < 1)
                return Clutter.EVENT_STOP;
            step = Math.sign(this._shiftScroll);
            this._shiftScroll = 0;
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        const now = GLib.get_monotonic_time() / 1000;
        if (now - (this._lastShiftScroll ?? 0) < 150)
            return Clutter.EVENT_STOP;
        this._lastShiftScroll = now;
        const windows = this.windows;
        const index = windows.indexOf(global.display.focus_window);
        const next = index === -1 ? 0 : (index + step + windows.length) % windows.length;
        activate(windows[next]);
        return Clutter.EVENT_STOP;
    }

    // Menu del tasto destro, costruito qui per separare le finestre di questo
    // schermo da quelle altrove (il menu standard di GNOME le mescola).
    _openMenu() {
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this.actor, 0.5, popupSide(this.bar.ext.side));
            this._menu.actor.add_style_class_name('barra-menu');
            this._menu.connect('open-state-changed', (_m, open) => {
                this.menuOpen = open;
                setClass(this.actor, 'menu-open', open);
                if (!open)
                    this.bar.ext.nudgeAutohide();
            });
            Main.uiGroup.add_child(this._menu.actor);
            this.bar.menuManager.addMenu(this._menu);
            this._menu.actor.hide();
        }
        this._fillMenu(this._menu);
        this._menu.open();
    }

    _fillMenu(menu) {
        menu.removeAll();
        const app = this.app;
        const focus = global.display.focus_window;
        const addWindow = w => {
            const item = menu.addAction(w.get_title() ?? app.get_name(), () => activate(w));
            item.setOrnament(w === focus ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        };

        if (this.windows.length > 0) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('On this screen')));
            this.windows.forEach(addWindow);
        }
        for (const [place, windows] of groupByPlace(this.elsewhere, this.bar.monitorIndex)) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(place));
            windows.forEach(addWindow);
        }
        if (this.windows.length + this.elsewhere.length > 0)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const newWindow = app.can_open_new_window();
        if (newWindow)
            menu.addAction(_('New window here'), () => app.open_new_window(-1));
        const appInfo = app.get_app_info();
        for (const action of appInfo?.list_actions() ?? []) {
            // GNOME apre la nuova finestra proprio con l'azione "new-window"
            // dell'app: sarebbe un doppione della voce qui sopra.
            if (newWindow && action === 'new-window')
                continue;
            menu.addAction(appInfo.get_action_name(action),
                (event) => app.launch_action(action, event?.get_time?.() ?? 0, -1));
        }

        // Documenti recenti: il menu si apre subito, la sezione si riempie
        // appena l'elenco è letto (senza bloccare la shell).
        const recentSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(recentSection);
        const token = this._menuToken = (this._menuToken ?? 0) + 1;
        recentFilesFor(app, RECENT_MAX).then(recent => {
            if (token !== this._menuToken || !this._menu || recent.length === 0)
                return;
            recentSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recent files')));
            for (const uri of recent) {
                recentSection.addAction(Gio.File.new_for_uri(uri).get_basename(), () => {
                    app.get_app_info()?.launch_uris([uri], global.create_app_launch_context(0, -1));
                });
            }
        }).catch(() => {});

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const favorites = AppFavorites.getAppFavorites();
        const id = app.get_id();
        if (app.get_app_info()) {
            if (favorites.isFavorite(id))
                menu.addAction(_('Unpin'), () => favorites.removeFavorite(id));
            else
                menu.addAction(_('Pin'), () => favorites.addFavorite(id));
        }
        // Tenere in cima: solo per le app aperte e solo per questa sessione.
        if (app.get_state() !== Shell.AppState.STOPPED) {
            const ext = this.bar.ext;
            menu.addAction(ext.isKeptOnTop(id) ? _('Stop keeping first') : _('Keep first'),
                () => ext.toggleKeepOnTop(id));
            menu.addAction(_('Quit'), () => app.request_quit());
        }
    }

    destroy() {
        this._menuToken = (this._menuToken ?? 0) + 1;
        this.bar.ext.preview?.forget(this);
        this.bar.ext.cancelDndHover?.(this);
        this._dndTimeline?.stop();
        this._dndTimeline = null;
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = 0;
        this._menu?.destroy();
        this._menu = null;
        this.actor._delegate = null;
        this.actor.destroy();
    }
}

// ---------------------------------------------------------------------------
// Una barra per monitor.

class Bar {
    constructor(ext, monitorIndex) {
        this.ext = ext;
        this.monitorIndex = monitorIndex;
        this.items = new Map();
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this._scrollTarget = 0;
        this._follow = null;
        this._repeatId = 0;
        this._lastFocusId = null;
        this._arrowsShown = false;
        this._drag = null;
        this._listIds = [];
        this._spare = new Map();   // icone staccate, pronte da riusare

        this.horizontal = isHorizontal(ext.side);
        const orientation = this.horizontal ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL;
        this.actor = new St.BoxLayout({
            style_class: `barra barra-${ext.side}`,
            orientation,
            reactive: true,
        });

        // Pulsante app: griglia + trattini degli spazi di lavoro. Scorrendoci
        // sopra (rotella o trackpad, in qualsiasi direzione) si cambia spazio.
        this._workspaces = new St.BoxLayout({
            style_class: 'barra-workspaces',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        // Alto come lente e stella: la griglia ha due file di puntini invece
        // di tre, per lasciare posto ai trattini sotto.
        const appsWidth = this.horizontal ? TOOL_HEIGHT : ITEM;
        const appsHeight = this.horizontal ? ITEM : TOOL_HEIGHT;
        const appsContent = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: appsWidth,
            height: appsHeight,
            x_expand: false,
            y_expand: false,
        });
        appsContent.add_child(new St.Icon({
            gicon: new Gio.FileIcon({file: ext.dir.get_child('icons').get_child('barra-apps-symbolic.svg')}),
            icon_size: 20,
            style_class: 'barra-apps-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        appsContent.add_child(this._workspaces);
        this._appsButton = new St.Button({
            style_class: 'barra-item barra-apps',
            child: appsContent,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: appsWidth,
            height: appsHeight,
            x_expand: false,
            y_expand: false,
        });
        this._wsScroll = 0;
        this._wsLastSwitch = 0;
        this._appsButton.connect('scroll-event', (_a, event) => this._onWorkspaceScroll(event));
        this._appsButton.connect('clicked', () => {
            if (Main.overview.visible)
                Main.overview.hide();
            else
                Main.overview.showApps();
        });
        // App tenute in cima (o all'inizio, in basso): fuori dalla lista
        // scorrevole, sempre visibili.
        this._top = new St.BoxLayout({
            orientation,
            style: `spacing: ${SPACING}px;`,
            visible: false,
        });
        this.actor.add_child(this._top);
        this._topSep = this._makeSep();
        this._topSep.visible = false;
        this.actor.add_child(this._topSep);


        // Freccia su / lista scorrevole / freccia giù. Le frecce compaiono solo
        // quando la lista non ci sta: sono il modo di scorrere senza rotella.
        this._up = this._makeArrow(this.horizontal ? 'pan-start-symbolic' : 'pan-up-symbolic', -1);
        this.actor.add_child(this._up);

        this._list = new St.BoxLayout({
            orientation,
            style: `spacing: ${SPACING}px;`,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._scroll = new St.ScrollView({
            style_class: 'barra-scroll',
            hscrollbar_policy: this.horizontal ? St.PolicyType.EXTERNAL : St.PolicyType.NEVER,
            vscrollbar_policy: this.horizontal ? St.PolicyType.NEVER : St.PolicyType.EXTERNAL,
            overlay_scrollbars: true,
            x_expand: this.horizontal,
            y_expand: !this.horizontal,
            child: this._list,
        });
        // L'asse su cui scorre la lista: verticale, oppure orizzontale in basso.
        this._adj = this.horizontal ? this._scroll.hadjustment : this._scroll.vadjustment;
        this._scroll.connect('scroll-event', (_a, event) => this._onScroll(event));
        this.actor.add_child(this._scroll);

        this._down = this._makeArrow(this.horizontal ? 'pan-end-symbolic' : 'pan-down-symbolic', 1);
        this.actor.add_child(this._down);

        // Area di sistema (solo sulla barra dello schermo principale): icone
        // visibili e/o il "cassetto" che le apre accanto alla barra.
        this._trayKey = '';
        this._trayBox = new St.BoxLayout({
            style_class: 'barra-tray',
            orientation: this.horizontal ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        // In fondo (o alla fine, in basso), dopo un solo separatore: area di
        // sistema, ricerca, stella e griglia delle app, tutti della stessa misura.
        this.actor.add_child(this._makeSep());
        this.actor.add_child(this._trayBox);
        const tool = (icon, action) => {
            const button = new St.Button({
                style_class: 'barra-item barra-apps barra-tool',
                child: new St.Icon({icon_name: icon, icon_size: 16}),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                width: this.horizontal ? TOOL_HEIGHT : ITEM,
                height: this.horizontal ? ITEM : TOOL_HEIGHT,
            });
            button.connect('clicked', action);
            this.actor.add_child(button);
            return button;
        };
        // Lente. Con un filtro fissato diventa un imbuto azzurro: un clic
        // toglie il filtro.
        this._searchButton = tool('system-search-symbolic', () => {
            if (ext.pinnedSearch)
                ext.clearPinnedSearch();
            else
                ext.search.toggle();
        });
        this._searchIcon = this._searchButton.child;
        this._filterGicon = new Gio.FileIcon({file: ext.dir.get_child('icons').get_child('barra-filter-symbolic.svg')});
        this._starButton = tool('starred-symbolic', () => ext.toggleOpenOnly());
        // Ultimo, nell'angolo: la griglia delle app, come nella dash di GNOME.
        this.actor.add_child(this._appsButton);

        const adj = this._adj;
        adj.connect('changed', () => this._updateArrows());
        adj.connect('notify::value', () => {
            this._updateArrows();
            if (this._drag?.active)
                this._dragMove();
        });

        // Tutti gli eventi della barra passano di qui prima di arrivare alle
        // icone: serve a seguire il trascinamento.
        this.actor.connect('captured-event', (_a, event) => this._onCaptured(event));
        // Tasto destro sullo sfondo della barra o sulla griglia: la finestrella
        // con le informazioni e le impostazioni. Sulle icone resta il loro menu.
        this.actor.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY || !this._isInfoTarget(event))
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            const g = this.geometry;
            if (this.horizontal)
                ext.info.open(x, g.y);
            else
                ext.info.open(ext.side === 'right' ? g.x : g.x + g.width, y);
            return Clutter.EVENT_STOP;
        });

        // Nascondimento automatico (opzione, spento di default): la barra non
        // riserva spazio, esce dallo schermo quando una finestra la copre e
        // torna portando il mouse sul bordo.
        this._autohide = ext.autohide;
        this._hidden = false;
        this._revealed = false;
        this._hideCheckId = 0;
        Main.layoutManager.addChrome(this.actor, {
            affectsStruts: !this._autohide,
            trackFullscreen: true,
        });
        if (this._autohide) {
            this.actor.track_hover = true;
            this.actor.connect('notify::hover', () => {
                if (this.actor.hover)
                    return;
                this._revealed = false;
                this._scheduleHideCheck();
            });
            // Striscia invisibile sul bordo dello schermo: ci si porta il mouse
            // e la barra rientra.
            this._edge = new St.Widget({reactive: true, visible: false});
            this._edge.connect('enter-event', () => {
                this._revealed = true;
                this._setHidden(false);
            });
            Main.layoutManager.addChrome(this._edge, {affectsStruts: false, trackFullscreen: true});
        }
        // Nell'elenco di Ctrl+Alt+Tab, accanto alla barra in alto di GNOME.
        const name = Main.layoutManager.monitors.length > 1 && ext.getSettings().get_boolean('all-monitors')
            ? `Barretta · ${_('Screen %d').format(monitorIndex + 1)}` : 'Barretta';
        Main.ctrlAltTabManager.addGroup(this.actor, name, 'view-app-grid-symbolic', {
            focusCallback: () => this.focus(),
        });
        this.relayout();
    }

    // Filo di separazione: orizzontale nella barra verticale, verticale in basso.
    _makeSep() {
        return new St.Widget({
            style_class: this.horizontal ? 'barra-sep barra-sep-v' : 'barra-sep',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    // Coordinata lungo la barra: y in verticale, x in basso.
    _along(x, y) {
        return this.horizontal ? x : y;
    }

    // ---- area di sistema ----

    // Dove ancorare un menu accanto a un attore della barra (verso lo schermo).
    anchorFor(actor) {
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        const g = this.geometry;
        if (this.horizontal)
            return [ax + aw / 2, g.y];
        return [this.ext.side === 'right' ? g.x : g.x + g.width, ay + ah / 2];
    }

    updateTray(items, mode, max, revision) {
        const show = mode !== 'none' && this.monitorIndex === Main.layoutManager.primaryIndex && items.length > 0;
        if (`${show}:${mode}:${max}:${revision}` === this._trayRev)
            return;
        this._trayRev = `${show}:${mode}:${max}:${revision}`;
        // Stesse icone nello stesso ordine: si aggiornano solo icona e stato,
        // senza ricostruire i pulsanti.
        const key = `${show}:${mode}:${max}:${items.map(i => i.key).join(',')}`;
        if (key === this._trayKey) {
            for (const button of this._trayBox.get_children()) {
                const item = button._trayItem;
                if (item) {
                    button.child.gicon = item.icon;
                    setClass(button, 'attention', item.needsAttention);
                } else if (button._drawerItems) {
                    setClass(button, 'attention', button._drawerItems.some(i => i.needsAttention));
                }
            }
            return;
        }
        this._trayKey = key;
        this._trayBox.destroy_all_children();
        this._trayBox.visible = show;
        if (!show)
            return;
        // "Visibili": le prime N (o tutte) nella barra, le altre nel cassetto.
        // "Cassetto": tutte nel cassetto.
        const inline = mode === 'inline' ? (max > 0 ? items.slice(0, max) : items) : [];
        const drawer = items.filter(i => !inline.includes(i));
        for (const item of inline) {
            try {
                this._trayBox.add_child(this._makeTrayButton(item, null));
            } catch (e) {
                logError(e, 'Barretta: tray icon');
            }
        }
        if (drawer.length > 0)
            this._trayBox.add_child(this._makeDrawerButton(drawer, mode === 'inline'));
    }

    _makeTrayButton(item, onBeforeAction) {
        const button = new St.Button({
            style_class: 'barra-tray-item',
            child: new St.Icon({gicon: item.icon, icon_size: TRAY_ICON}),
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE | St.ButtonMask.SECONDARY,
            can_focus: true,
            width: TRAY_BUTTON,
            height: TRAY_BUTTON,
            x_align: Clutter.ActorAlign.CENTER,
            accessible_name: item.title,
        });
        button._trayItem = item;
        setClass(button, 'attention', item.needsAttention);
        button.connect('clicked', (_b, mouse) => {
            onBeforeAction?.();
            const [x, y] = this.anchorFor(button);
            const wantsMenu = mouse === Clutter.BUTTON_SECONDARY || (mouse === Clutter.BUTTON_PRIMARY && item.itemIsMenu);
            if (mouse === Clutter.BUTTON_MIDDLE)
                item.secondaryActivate(x, y);
            else if (wantsMenu && item.menuPath)
                this.ext.trayMenu.open(x, y, (menu, valid) => item.fillMenu(menu, valid));
            else if (mouse === Clutter.BUTTON_SECONDARY)
                item.contextMenu(x, y);
            else
                item.activate(x, y);
        });
        button.connect('scroll-event', (_a, event) => {
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.DOWN)
                item.scroll(dir === Clutter.ScrollDirection.UP ? -1 : 1, 'vertical');
            return Clutter.EVENT_STOP;
        });
        return button;
    }

    // Il cassetto: freccina (modalità cassetto) o "+N" (modalità visibili).
    // Un clic apre le icone accanto alla barra. Se una chiede attenzione, si accende.
    _makeDrawerButton(items, countOnly) {
        const arrow = this.horizontal ? 'pan-up-symbolic'
            : this.ext.side === 'right' ? 'pan-start-symbolic' : 'pan-end-symbolic';
        const child = countOnly
            ? new St.Label({text: `+${items.length}`, style_class: 'barra-tray-more', y_align: Clutter.ActorAlign.CENTER})
            : new St.Icon({icon_name: arrow, icon_size: 16});
        const button = new St.Button({
            style_class: 'barra-item barra-apps barra-tool barra-tray-drawer',
            child,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            width: countOnly ? TRAY_BUTTON : (this.horizontal ? TOOL_HEIGHT : ITEM),
            height: countOnly ? TRAY_BUTTON : (this.horizontal ? ITEM : TOOL_HEIGHT),
            accessible_name: _('System tray'),
        });
        button._drawerItems = items;
        setClass(button, 'attention', items.some(i => i.needsAttention));
        button.connect('clicked', () => {
            const [x, y] = this.anchorFor(button);
            this.ext.trayMenu.open(x, y, menu => {
                const grid = new St.Widget({
                    style_class: 'barra-tray-grid',
                    layout_manager: new Clutter.GridLayout({column_spacing: 4, row_spacing: 4}),
                });
                const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(items.length))));
                items.forEach((item, i) => {
                    let b;
                    try {
                        b = this._makeTrayButton(item, () => menu.close());
                    } catch {
                        return;
                    }
                    b.set_size(TRAY_BUTTON + 8, TRAY_BUTTON + 8);
                    grid.layout_manager.attach(b, i % columns, Math.floor(i / columns), 1, 1);
                });
                const holder = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                    can_focus: false,
                    style_class: 'barra-tray-holder',
                });
                holder.remove_style_pseudo_class('insensitive');
                // Niente spazio per il segno di spunta: ci sono solo icone.
                holder.setOrnament(PopupMenu.Ornament.HIDDEN);
                holder.add_child(grid);
                menu.addMenuItem(holder);
                // Il cassetto si stringe attorno alle icone (senza la larghezza
                // minima dei menu con testo).
                menu.actor.add_style_class_name('barra-drawer-menu');
                return Promise.resolve(true);
            });
        });
        return button;
    }

    dropSpare(id) {
        const item = this._spare.get(id);
        if (item) {
            item.destroy();
            this._spare.delete(id);
        }
    }

    // Le icone nell'ordine in cui si vedono.
    orderedItems() {
        const byActor = new Map([...this.items.values()].map(i => [i.actor, i]));
        return [...this._top.get_children(), ...this._list.get_children()]
            .map(a => byActor.get(a)).filter(Boolean);
    }

    // Fuoco della tastiera sulla barra: sull'app attiva, se c'è, altrimenti
    // sulla prima. Poi frecce per muoversi, Invio per aprire, Menu per il
    // menu, Esc per tornare alla finestra.
    focus() {
        const items = this.orderedItems();
        const target = items.find(i => i.focused) ?? items[0];
        target?.actor.grab_key_focus();
    }

    // La finestrella si apre solo sullo sfondo della barra o sulla griglia:
    // icone, area di sistema, lente, stella e frecce hanno il loro clic destro.
    _isInfoTarget(event) {
        for (let a = global.stage.get_event_actor(event); a && a !== this.actor; a = a.get_parent()) {
            if (a === this._appsButton)
                return true;
            if (a instanceof St.Button)
                return false;
        }
        return true;
    }

    _isOnAppItem(event) {
        const items = new Set([...this.items.values()].map(i => i.actor));
        for (let a = global.stage.get_event_actor(event); a && a !== this.actor; a = a.get_parent()) {
            if (items.has(a))
                return true;
        }
        return false;
    }

    // ---- trascinamento per riordinare ----
    //
    // Si tiene premuto su un'icona della lista e la si sposta: oltre qualche
    // pixel il clic diventa trascinamento. Nessuna icona si muove: quella presa
    // resta al suo posto, tratteggiata, e una barra colorata mostra dove andrà.
    // Fermi un secondo su una freccia, la lista scorre di una pagina (e poi
    // ancora, ogni secondo); anche la rotella funziona. Rilasciando, il nuovo
    // ordine viene salvato. Esc annulla.

    dragPrepare(item, event) {
        // Un trascinamento rimasto appeso (rilascio perso) si chiude qui.
        if (this._drag?.active)
            this._dragEnd(true);
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || item.actor.get_parent() !== this._list)
            return;
        const [x, y] = event.get_coords();
        this._drag = {item, start: this._along(x, y), x, y, active: false};
    }

    _onCaptured(event) {
        const d = this._drag;
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        switch (event.type()) {
        case Clutter.EventType.MOTION: {
            // Movimento reale senza tasto premuto: il rilascio si è perso per
            // strada. (Si ignorano i movimenti sintetici che GNOME genera quando
            // una finestra compare sotto il puntatore: non portano lo stato dei tasti.)
            const synthetic = event.get_flags() & Clutter.EventFlags.FLAG_SYNTHETIC;
            if (!synthetic && !(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                if (d.active)
                    this._dragEnd(true);
                else
                    this._drag = null;
                return Clutter.EVENT_PROPAGATE;
            }
            [d.x, d.y] = event.get_coords();
            if (!d.active) {
                if (Math.abs(this._along(d.x, d.y) - d.start) < DRAG_THRESHOLD)
                    return Clutter.EVENT_PROPAGATE;
                this._dragBegin();
            }
            this._dragMove();
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.BUTTON_PRESS:
            // Un clic mentre un trascinamento è ancora aperto lo chiude.
            if (d.active) {
                this._dragEnd(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        case Clutter.EventType.BUTTON_RELEASE:
            if (d.active) {
                this._dragEnd(true);
                return Clutter.EVENT_STOP;
            }
            this._drag = null;
            return Clutter.EVENT_PROPAGATE;
        case Clutter.EventType.SCROLL:
            if (!d.active)
                return Clutter.EVENT_PROPAGATE;
            this._onScroll(event);
            this._dragMove();
            return Clutter.EVENT_STOP;
        case Clutter.EventType.KEY_PRESS:
            if (d.active && event.get_key_symbol() === Clutter.KEY_Escape) {
                this._dragEnd(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _dragBegin() {
        const d = this._drag;
        d.active = true;
        d.children = this._list.get_children();
        d.from = d.children.indexOf(d.item.actor);
        d.gap = -1;
        d.arrow = 0;
        d.arrowId = 0;
        d.item.suppressClick = true;
        d.grab = global.stage.grab(this.actor);
        // Se GNOME toglie la presa (un'altra finestra o un menu se la prende),
        // il trascinamento finisce lì, con la posizione raggiunta.
        d.grab.connect('notify::revoked', () => {
            if (d.grab.revoked && this._drag === d)
                this._dragEnd(true);
        });
        d.item.setDragging(true);
        // Barra colorata che segna il punto d'inserimento, sopra tutto.
        d.line = new St.Widget({style_class: 'barra-drop-line', visible: false});
        Main.uiGroup.add_child(d.line);   // solo disegno: niente area d'ingresso da ricalcolare
        this.ext.preview.suppress();
        this._stopFollow();
        this._dragMove();
    }

    _inside(actor, x, y) {
        if (!actor.visible)
            return false;
        const [ok, ax, ay] = actor.transform_stage_point(x, y);
        return ok && ax >= 0 && ay >= 0 && ax < actor.width && ay < actor.height;
    }

    _dragMove() {
        const d = this._drag;
        if (!d?.active)
            return;
        this.ext.preview.suppress();

        // Sopra una freccia: dopo un secondo fermo, una pagina; poi ogni secondo.
        const arrow = this._inside(this._up, d.x, d.y) ? -1 : this._inside(this._down, d.x, d.y) ? 1 : 0;
        if (arrow !== d.arrow) {
            d.arrow = arrow;
            if (d.arrowId)
                GLib.source_remove(d.arrowId);
            d.arrowId = 0;
            setClass(this._up, 'drop-target', arrow === -1);
            setClass(this._down, 'drop-target', arrow === 1);
            if (arrow !== 0) {
                d.arrowId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ARROW_PAGE_DELAY, () => {
                    const page = Math.max(SLOT, Math.floor(this._adj.page_size / SLOT) * SLOT);
                    this.scrollBy(arrow * page);
                    return GLib.SOURCE_CONTINUE;
                });
            }
        }

        // Punto d'inserimento: lo spazio tra due icone più vicino al puntatore.
        const n = d.children.length;
        const [ok, lx0, ly0] = this._list.transform_stage_point(d.x, d.y);
        if (!ok)
            return;
        const gap = Math.max(0, Math.min(n, Math.round(this._along(lx0, ly0) / SLOT)));
        // Sopra una freccia si sta solo scorrendo: rilasciare lì non sposta nulla.
        d.gap = arrow !== 0 ? -1 : gap;
        // Rilasciare subito sopra o subito sotto l'icona stessa non la sposta.
        const noop = gap === d.from || gap === d.from + 1;
        // Posizione a schermo presa dalle icone stesse (già scorse).
        const ref = d.children[Math.min(gap, n - 1)];
        const [rx, ry] = ref.get_transformed_position();
        const [rw, rh] = ref.get_transformed_size();
        const [sx, sy] = this._scroll.get_transformed_position();
        const [sw, sh] = this._scroll.get_transformed_size();
        if (this.horizontal) {
            // In basso la barra d'inserimento è verticale, tra due icone.
            const lineX = gap < n ? rx - SPACING / 2 : rx + rw + SPACING / 2;
            const inView = lineX >= sx - 2 && lineX <= sx + sw + 2;
            d.line.visible = !noop && inView && arrow === 0;
            if (d.line.visible) {
                d.line.set_size(DROP_LINE_HEIGHT, DROP_LINE_WIDTH);
                d.line.set_position(Math.round(lineX - DROP_LINE_HEIGHT / 2), Math.round(ry + (rh - DROP_LINE_WIDTH) / 2));
            }
        } else {
            const lineY = gap < n ? ry - SPACING / 2 : ry + rh + SPACING / 2;
            const inView = lineY >= sy - 2 && lineY <= sy + sh + 2;
            d.line.visible = !noop && inView && arrow === 0;
            if (d.line.visible) {
                d.line.set_size(DROP_LINE_WIDTH, DROP_LINE_HEIGHT);
                d.line.set_position(Math.round(rx + (rw - DROP_LINE_WIDTH) / 2), Math.round(lineY - DROP_LINE_HEIGHT / 2));
            }
        }
    }

    _dragEnd(commit, destroying = false) {
        const d = this._drag;
        this._drag = null;
        if (d.arrowId)
            GLib.source_remove(d.arrowId);
        setClass(this._up, 'drop-target', false);
        setClass(this._down, 'drop-target', false);
        d.grab?.dismiss();
        d.line?.destroy();
        d.item.setDragging(false);
        // Il rilascio non deve diventare anche un clic sull'icona.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            d.item.suppressClick = false;
            return GLib.SOURCE_REMOVE;
        });
        const noop = d.gap < 0 || d.gap === d.from || d.gap === d.from + 1;
        if (commit && !noop && !destroying) {
            // Si sposta solo l'icona trascinata, accanto a quella che la segue
            // (o dopo quella che la precede) fra le visibili: le app nascoste
            // (filtro, stella spenta, tenute all'inizio) restano dove sono.
            const ids = this._listIds.filter((_id, i) => i !== d.from);
            const moved = this._listIds[d.from];
            const at = d.gap > d.from ? d.gap - 1 : d.gap;
            this.ext.moveInOrder(moved, ids[at] ?? null, ids[at - 1] ?? null, this._fullIds);
        }
        if (!destroying)
            this.ext.queueUpdate();
    }

    get geometry() {
        const monitor = Main.layoutManager.monitors[this.monitorIndex];
        const top = this.monitorIndex === Main.layoutManager.primaryIndex
            ? Main.layoutManager.panelBox.height : 0;
        if (this.horizontal) {
            // In basso: tutta la larghezza dello schermo.
            return {x: monitor.x, y: monitor.y + monitor.height - BAR_WIDTH, width: monitor.width, height: BAR_WIDTH};
        }
        const x = this.ext.side === 'right' ? monitor.x + monitor.width - BAR_WIDTH : monitor.x;
        return {x, y: monitor.y + top, width: BAR_WIDTH, height: monitor.height - top};
    }

    relayout() {
        const g = this.geometry;
        this.actor.set_position(g.x, g.y);
        this.actor.set_size(g.width, g.height);
        if (this._edge) {
            const e = EDGE_SIZE;
            if (this.horizontal)
                this._edge.set({x: g.x, y: g.y + g.height - e, width: g.width, height: e});
            else if (this.ext.side === 'right')
                this._edge.set({x: g.x + g.width - e, y: g.y, width: e, height: g.height});
            else
                this._edge.set({x: g.x, y: g.y, width: e, height: g.height});
        }
    }

    // ---- nascondimento automatico ----

    _scheduleHideCheck() {
        if (!this._autohide || this._hideCheckId || this._destroyed)
            return;
        this._hideCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUTOHIDE_DELAY, () => {
            this._hideCheckId = 0;
            this.updateAutohide();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Nascosta solo se una finestra la copre e non la si sta usando.
    updateAutohide() {
        if (!this._autohide || this._destroyed)
            return;
        const g = this.geometry;
        const workspace = global.workspace_manager.get_active_workspace();
        const covered = global.get_window_actors().map(a => a.meta_window).some(w => {
            if (!w || w.minimized || !w.showing_on_its_workspace() || w.get_monitor() !== this.monitorIndex ||
                !w.located_on_workspace(workspace) || w.get_window_type() === Meta.WindowType.DESKTOP)
                return false;
            const r = w.get_frame_rect();
            return r.x < g.x + g.width && r.x + r.width > g.x && r.y < g.y + g.height && r.y + r.height > g.y;
        });
        const ext = this.ext;
        const inUse = this.actor.hover || this._revealed || this._drag?.active ||
            [...this.items.values()].some(i => i.menuOpen) || ext.info?._menu?.isOpen ||
            ext.search?.isOpen || ext.preview?.actor.visible ||
            global.stage.get_key_focus() && this.actor.contains(global.stage.get_key_focus());
        this._setHidden(covered && !inUse);
    }

    _setHidden(hidden) {
        if (hidden === this._hidden)
            return;
        this._hidden = hidden;
        const g = this.geometry;
        const params = {duration: AUTOHIDE_ANIMATION, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
        if (this.horizontal)
            this.actor.ease({translation_y: hidden ? g.height : 0, ...params});
        else
            this.actor.ease({translation_x: hidden ? (this.ext.side === 'right' ? g.width : -g.width) : 0, ...params});
        if (this._edge)
            this._edge.visible = hidden;
    }

    // Stella accesa: si vedono anche le preferite chiuse. Spenta: solo le aperte.
    setOpenOnly(openOnly) {
        if (openOnly === this._openOnlyShown)
            return;
        this._openOnlyShown = openOnly;
        this._starButton.child.icon_name = openOnly ? 'non-starred-symbolic' : 'starred-symbolic';
        setClass(this._starButton, 'active', !openOnly);
    }

    setSearching(searching, pinnedText) {
        const pinned = pinnedText !== null;
        if (`${searching}:${pinned}` === this._searchShown)
            return;
        this._searchShown = `${searching}:${pinned}`;
        setClass(this._searchButton, 'active', searching);
        setClass(this._searchButton, 'filtering', pinned);
        if (pinned)
            this._searchIcon.gicon = this._filterGicon;
        else
            this._searchIcon.icon_name = 'system-search-symbolic';
    }

    // ---- spazi di lavoro ----

    updateWorkspaces() {
        const wm = global.workspace_manager;
        const n = wm.n_workspaces;
        const active = wm.get_active_workspace_index();
        const dots = this._workspaces.get_children();
        for (let i = dots.length; i < n; i++)
            this._workspaces.add_child(new St.Widget({style_class: 'barra-ws'}));
        for (let i = n; i < dots.length; i++)
            dots[i].destroy();
        this._workspaces.get_children().forEach((d, i) => setClass(d, 'active', i === active));
    }

    _switchWorkspace(direction) {
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._wsLastSwitch < WS_SWITCH_INTERVAL)
            return;
        const wm = global.workspace_manager;
        const index = wm.get_active_workspace_index() + direction;
        if (index < 0 || index >= wm.n_workspaces)
            return;
        this._wsLastSwitch = now;
        wm.get_workspace_by_index(index).activate(global.get_current_time());
    }

    _onWorkspaceScroll(event) {
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            this._switchWorkspace(-1);
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            this._switchWorkspace(1);
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            // Trackpad: si accumula il movimento e si cambia spazio a ogni
            // "unità" di scorrimento, un passo alla volta.
            const [dx, dy] = event.get_scroll_delta();
            this._wsScroll += Math.abs(dx) > Math.abs(dy) ? dx : dy;
            if (Math.abs(this._wsScroll) >= 1) {
                this._switchWorkspace(Math.sign(this._wsScroll));
                this._wsScroll = 0;
            }
            if (event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE)
                this._wsScroll = 0;
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    // ---- scorrimento ----

    _maxScroll() {
        const adj = this._adj;
        return Math.max(0, adj.upper - adj.page_size);
    }

    // Scorrimento verso una destinazione, con un "inseguitore" che a ogni
    // fotogramma avvicina la posizione alla destinazione (smorzamento
    // esponenziale). Ogni evento sposta solo la destinazione: la lista si muove
    // già mentre gli eventi arrivano, anche se ne arrivano a decine al secondo.
    // (Prima ogni evento ricominciava un'animazione da zero: con il trackpad
    // l'animazione non partiva mai finché non ci si fermava.)
    scrollTo(target, animate = true) {
        const adj = this._adj;
        target = Math.max(0, Math.min(target, this._maxScroll()));
        this._scrollTarget = target;
        if (!animate || !St.Settings.get().enable_animations) {
            this._stopFollow();
            adj.value = target;
            return;
        }
        this._startFollow();
    }

    scrollBy(delta, animate = true) {
        this.ext.preview.suppress();
        const from = this._follow ? this._scrollTarget : this._adj.value;
        this.scrollTo(from + delta, animate);
    }

    _startFollow() {
        if (this._follow)
            return;
        const timeline = new Clutter.Timeline({actor: this.actor, duration: 60000});
        this._follow = timeline;
        timeline.connect('new-frame', () => {
            const adj = this._adj;
            // La lista può accorciarsi mentre si scorre: la meta si riadatta,
            // e se la posizione non si muove più ci si ferma.
            this._scrollTarget = Math.max(0, Math.min(this._scrollTarget, this._maxScroll()));
            const diff = this._scrollTarget - adj.value;
            const before = adj.value;
            if (Math.abs(diff) < 0.5) {
                adj.value = this._scrollTarget;
                this._stopFollow();
                return;
            }
            adj.value += diff * (1 - Math.exp(-timeline.get_delta() / FOLLOW_TAU));
            if (adj.value === before) {
                this._stopFollow();
                return;
            }
            this.ext.preview.suppress();
        });
        // A fine corsa (o se fermata da fuori) non deve restare "occupata".
        timeline.connect('stopped', () => {
            if (this._follow === timeline)
                this._follow = null;
        });
        timeline.start();
    }

    _stopFollow() {
        this._follow?.stop();
        this._follow = null;
    }

    // Trackpad o rotella? Il trackpad manda spostamenti continui e frazionari,
    // la rotella scatti interi (o frazioni regolari per le rotelle ad alta
    // risoluzione). Nella shell in finestra la sorgente può arrivare "sconosciuta",
    // quindi si guarda anche il valore.
    _isTouchpad(event, dy) {
        const source = event.get_scroll_source();
        if (source === Clutter.ScrollSource.FINGER || source === Clutter.ScrollSource.CONTINUOUS)
            return true;
        if (source === Clutter.ScrollSource.WHEEL)
            return false;
        const device = event.get_source_device();
        if (device?.get_device_type() === Clutter.InputDeviceType.TOUCHPAD_DEVICE)
            return true;
        return Math.abs(dy * 8 - Math.round(dy * 8)) > 0.01;
    }

    _onScroll(event) {
        // Gli scatti "emulati" duplicano gli eventi fluidi: si ignorano.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;

        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            this.scrollBy(-SCROLL_STEP);
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            this.scrollBy(SCROLL_STEP);
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            // La rotella è verticale anche con la barra in basso: si usa il
            // movimento più ampio dei due.
            const [dx, dyRaw] = event.get_scroll_delta();
            const dy = Math.abs(dx) > Math.abs(dyRaw) ? dx : dyRaw;
            if (this._isTouchpad(event, dy)) {
                // Trackpad: la lista segue le dita 1:1, senza ritardo.
                this.scrollBy(dy * TOUCHPAD_SCALE, false);
            } else {
                this.scrollBy(dy * SCROLL_STEP);
            }
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    _makeArrow(icon, direction) {
        const button = new St.Button({
            style_class: 'barra-arrow',
            child: new St.Icon({icon_name: icon, icon_size: 16}),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: this.horizontal ? 20 : ITEM,
            height: this.horizontal ? ITEM : 20,
            visible: false,
        });
        // Clic: scorre di un'icona. Tenuto premuto: scorre di continuo.
        button.connect('notify::pressed', () => {
            this._stopRepeat();
            if (!button.pressed)
                return;
            this.scrollBy(direction * SCROLL_STEP);
            this._repeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ARROW_REPEAT_DELAY, () => {
                this._repeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ARROW_REPEAT, () => {
                    this.scrollBy(direction * SCROLL_STEP / 2);
                    return GLib.SOURCE_CONTINUE;
                });
                return GLib.SOURCE_REMOVE;
            });
        });
        return button;
    }

    _stopRepeat() {
        if (this._repeatId)
            GLib.source_remove(this._repeatId);
        this._repeatId = 0;
    }

    _updateArrows() {
        const adj = this._adj;
        // Con le frecce visibili la lista ha meno spazio: se ne tiene conto per
        // non farle apparire e sparire di continuo al limite.
        const arrowsH = !this._arrowsShown ? 0
            : this.horizontal ? this._up.width + this._down.width : this._up.height + this._down.height;
        const overflow = adj.upper > adj.page_size + arrowsH + 1;
        if (overflow !== this._arrowsShown) {
            this._arrowsShown = overflow;
            this._up.visible = overflow;
            this._down.visible = overflow;
            setClass(this._scroll, 'overflow', overflow);
        }
        if (!overflow)
            this._stopRepeat();
        const atTop = adj.value <= 0.5;
        const atBottom = adj.value >= this._maxScroll() - 0.5;
        setClass(this._up, 'end', atTop);
        setClass(this._down, 'end', atBottom);
        if ((atTop && this._up.pressed) || (atBottom && this._down.pressed))
            this._stopRepeat();
    }

    // Porta in vista un'icona, solo se è fuori.
    _ensureVisible(item) {
        const adj = this._adj;
        const box = item.actor.get_allocation_box();
        const [a1, a2] = this.horizontal ? [box.x1, box.x2] : [box.y1, box.y2];
        if (a2 <= a1)
            return;
        if (a1 < adj.value)
            this.scrollTo(a1);
        else if (a2 > adj.value + adj.page_size)
            this.scrollTo(a2 - adj.page_size);
    }

    // ---- contenuto ----

    // entries: [{app, windows, elsewhere}] in ordine stabile.
    update(entries, focusWindow) {
        // Durante un trascinamento la lista resta ferma: si aggiorna al rilascio.
        if (this._drag?.active)
            return;
        // Aggiorna senza ricostruire: riusa le icone esistenti, sposta solo se serve.
        const keep = new Set();
        let focused = null;
        // Le app "tenute in cima" vanno nella sezione fissa, le altre nella lista.
        const onTop = entries.filter(e =>
            this.ext.isKeptOnTop(e.app.get_id()) && e.windows.length + e.elsewhere.length > 0);
        const inList = entries.filter(e => !onTop.includes(e));
        const place = (box, {app, windows, elsewhere}, i) => {
            const id = app.get_id();
            keep.add(id);
            let item = this.items.get(id) ?? this._spare.get(id);
            if (!item) {
                item = new AppItem(this, app);
            }
            this._spare.delete(id);
            this.items.set(id, item);
            const parent = item.actor.get_parent();
            if (parent !== box) {
                parent?.remove_child(item.actor);
                box.insert_child_at_index(item.actor, i);
            } else if (box.get_child_at_index(i) !== item.actor) {
                box.set_child_at_index(item.actor, i);
            }
            item.update(windows, elsewhere, focusWindow,
                this.ext.notifications.countFor(id), this.ext.notifications.progressFor(id));
            if (item.focused)
                focused = item;
        };
        onTop.forEach((e, i) => place(this._top, e, i));
        inList.forEach((e, i) => place(this._list, e, i));
        this._listIds = inList.map(e => e.app.get_id());
        this._top.visible = onTop.length > 0;
        this._topSep.visible = onTop.length > 0;
        // Le icone che escono dalla barra ma la cui app è ancora aperta (per
        // esempio su un altro desktop) si tengono da parte, staccate: al
        // ritorno si riusano invece di ricostruirle.
        for (const [id, item] of this.items) {
            if (keep.has(id))
                continue;
            this.items.delete(id);
            if (item.app.get_state() === Shell.AppState.STOPPED || item.menuOpen) {
                item.destroy();
                continue;
            }
            this.ext.preview.forget(item);
            item.actor.get_parent()?.remove_child(item.actor);
            this._spare.set(id, item);
        }
        while (this._spare.size > SPARE_MAX) {
            const [oldest, old] = this._spare.entries().next().value;
            old.destroy();
            this._spare.delete(oldest);
        }

        // Quando cambia l'app attiva (es. con Alt+Tab) e la sua icona è fuori
        // vista, la lista scorre fin lì. Non insegue mai lo scorrimento a mano.
        const focusId = focused?.app.get_id() ?? null;
        if (focused && focusId !== this._lastFocusId) {
            const laters = global.compositor.get_laters();
            laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
                if (this.items.get(focusId) === focused && focused.actor.get_parent() === this._list)
                    this._ensureVisible(focused);
                return GLib.SOURCE_REMOVE;
            });
        }
        this._lastFocusId = focusId;
    }

    setLight(light) {
        setClass(this.actor, 'light', light);
    }

    destroy() {
        // Da qui in poi nessun gestore deve più toccare questa barra (la
        // distruzione stessa genera eventi, per esempio l'uscita del mouse).
        this._destroyed = true;
        if (this._drag?.active)
            this._dragEnd(false, true);
        if (this._hideCheckId)
            GLib.source_remove(this._hideCheckId);
        if (this._edge) {
            Main.layoutManager.removeChrome(this._edge);
            this._edge.destroy();
        }
        this._stopRepeat();
        this._stopFollow();
        for (const item of this.items.values())
            item.destroy();
        for (const item of this._spare.values())
            item.destroy();
        this._spare.clear();
        this.items.clear();
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ricerca tra le finestre aperte. Si apre accanto alla barra (pulsante con la
// lente o Super+F). Mentre si scrive, filtra sia l'elenco del riquadro sia le
// icone della barra. Frecce per scegliere, Invio per andare, Esc per chiudere.
// Con il campo vuoto è un selettore veloce di tutte le finestre, le più
// recenti in alto.

const SEARCH_WIDTH = 380;
const SEARCH_MAX_RESULTS = 9;

class SearchPopup {
    constructor(ext) {
        this._ext = ext;
        this._backdrop = null;
        this._grab = null;
        this._results = [];
        this._selected = 0;
    }

    get isOpen() {
        return this._backdrop !== null;
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        const ext = this._ext;
        if (Main.overview.visible)
            Main.overview.hide();
        ext.preview.hide();

        const current = global.display.get_current_monitor();
        const bar = ext.bars.find(b => b.monitorIndex === current) ?? ext.bars[0];
        if (!bar)
            return;
        const monitor = Main.layoutManager.monitors[bar.monitorIndex];
        const g = bar.geometry;

        // Sfondo trasparente su tutto lo schermo: un clic fuori dal riquadro chiude.
        this._backdrop = new St.Widget({
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        this._panel = new St.BoxLayout({
            style_class: 'barra-search',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            width: SEARCH_WIDTH,
        });
        setClass(this._panel, 'light', ext.light);
        this._entry = new St.Entry({
            style_class: 'barra-search-entry',
            hint_text: _('Search: title, app, “desktop 2”…'),
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'barra-search-icon',
        }));
        this._list = new St.BoxLayout({
            style_class: 'barra-search-results',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._empty = new St.Label({style_class: 'barra-search-empty', text: _('No windows found'), visible: false});
        // Dal basso verso l'alto: campo (fermo, vicino alla lente), poi i
        // risultati con il migliore subito sopra il campo.
        this._panel.add_child(new St.Label({
            style_class: 'barra-search-hint',
            text: _('Enter: go to the window · Ctrl+Enter: keep the bar filtered'),
        }));
        this._panel.add_child(this._empty);
        this._panel.add_child(this._list);
        this._panel.add_child(this._entry);
        this._backdrop.add_child(this._panel);
        Main.layoutManager.addTopChrome(this._backdrop);

        this._bar = bar;

        this._backdrop.connect('button-press-event', (_a, event) => {
            if (global.stage.get_event_actor(event) === this._backdrop)
                this.close();
            return Clutter.EVENT_STOP;
        });
        this._entry.clutter_text.connect('text-changed', () => this._refresh());
        // Tasti speciali (Invio, frecce, Tab, Esc) intercettati sul riquadro,
        // prima che arrivino al campo di testo: il campo di GNOME gestisce
        // Invio per conto suo e il suo segnale non arriverebbe mai qui.
        this._backdrop.connect('captured-event', (_a, event) =>
            event.type() === Clutter.EventType.KEY_PRESS ? this._onKey(event) : Clutter.EVENT_PROPAGATE);

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        this._entry.grab_key_focus();
        // Una nuova ricerca annulla il filtro fissato: si riparte da zero.
        ext.clearPinnedSearch();
        this._refresh();
    }

    close() {
        if (!this.isOpen)
            return;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        Main.layoutManager.removeChrome(this._backdrop);
        this._backdrop.destroy();
        this._backdrop = null;
        this._results = [];
        this._ext.setSearch(null);
        this._ext.nudgeAutohide();
    }

    // Ctrl+Invio: la barra resta filtrata dopo la chiusura. A campo vuoto
    // toglie il filtro fissato.
    _pin() {
        const text = this._entry.get_text().trim();
        const tokens = this._tokens();
        this.close();
        if (tokens.length > 0)
            this._ext.pinSearch(text, tokens);
        else
            this._ext.clearPinnedSearch();
    }

    _tokens() {
        return normalize(this._entry.get_text()).split(/\s+/).filter(Boolean);
    }

    _refresh() {
        const tokens = this._tokens();
        this._ext.setSearch(tokens.length > 0 ? tokens : null);

        const tracker = Shell.WindowTracker.get_default();
        // Ordine "usate di recente": la finestra di prima è la seconda in lista,
        // così Super+F poi Invio torna alla finestra precedente.
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .filter(w => !w.skip_taskbar)
            .filter(w => tokens.length === 0 || windowMatches(w, tracker.get_window_app(w), tokens));

        this._results = windows.slice(0, SEARCH_MAX_RESULTS);
        this._selected = tokens.length === 0 && this._results.length > 1 ? 1 : 0;
        this._list.destroy_all_children();
        const multiMonitor = Main.layoutManager.monitors.length > 1;
        for (const w of this._results) {
            const app = tracker.get_window_app(w);
            const where = [];
            if (multiMonitor)
                where.push(_('Screen %d').format(w.get_monitor() + 1));
            const ws = w.get_workspace();
            if (ws)
                where.push(_('Desktop %d').format(ws.index() + 1));

            const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            text.add_child(new St.Label({style_class: 'barra-search-title', text: w.get_title() ?? ''}));
            text.add_child(new St.Label({
                style_class: 'barra-search-subtitle',
                text: [app?.get_name(), ...where].filter(Boolean).join(' · '),
            }));
            const row = new St.BoxLayout({
                style_class: 'barra-search-row-box',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            if (app)
                row.add_child(app.create_icon_texture(24));
            row.add_child(text);
            const button = new St.Button({
                style_class: 'barra-search-row',
                child: row,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            button.connect('clicked', () => this._activate(w));
            // In cima alla lista: i risultati crescono verso l'alto.
            this._list.insert_child_at_index(button, 0);
        }
        if (windows.length > this._results.length) {
            this._list.insert_child_at_index(new St.Label({
                style_class: 'barra-search-more',
                text: `+${windows.length - this._results.length} · ${_('type to narrow down')}`,
            }), 0);
        }
        this._empty.visible = this._results.length === 0;
        this._highlight();
        this._place();
    }

    // Accanto alla lente, in fondo alla barra: il riquadro cresce verso l'alto,
    // così il campo di ricerca resta vicino a dove si è cliccato.
    _place() {
        const monitor = Main.layoutManager.monitors[this._bar.monitorIndex];
        const g = this._bar.geometry;
        const [, natH] = this._panel.get_preferred_height(SEARCH_WIDTH);
        if (this._ext.side === 'bottom') {
            // Sopra la barra, allineato a destra dove sta la lente.
            const x = monitor.width - SEARCH_WIDTH - 8;
            const y = g.y - monitor.y - natH - 8;
            this._panel.set_position(x, Math.max(8, y));
            return;
        }
        const x = this._ext.side === 'right'
            ? g.x - monitor.x - SEARCH_WIDTH - 8
            : g.x - monitor.x + g.width + 8;
        const y = Math.max(g.y - monitor.y + 8, g.y - monitor.y + g.height - natH - 8);
        this._panel.set_position(x, y);
    }

    // Il risultato i-esimo sta in basso nella lista (posizione contata dal fondo).
    _highlight() {
        const children = this._list.get_children();
        children.forEach((c, i) => setClass(c, 'selected', children.length - 1 - i === this._selected));
    }

    _activate(window) {
        this.close();
        activate(window);
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        const n = this._results.length;
        switch (key) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        // Su si allontana dal campo (risultati successivi), giù ci torna.
        case Clutter.KEY_Up:
        case Clutter.KEY_Tab:
            if (n > 0)
                this._selected = (this._selected + 1) % n;
            this._highlight();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_ISO_Left_Tab:
            if (n > 0)
                this._selected = (this._selected - 1 + n) % n;
            this._highlight();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (event.get_state() & Clutter.ModifierType.CONTROL_MASK)
                this._pin();
            else if (n > 0)
                this._activate(this._results[this._selected]);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    destroy() {
        this.close();
    }
}

// ---------------------------------------------------------------------------
// Finestrella del tasto destro sulla barra: cos'è, dimensione, lato.
// È ancorata a un punto invisibile e non alla barra, così resta aperta anche
// quando la barra si ricostruisce (cambio di dimensione o di lato).


// Un menu ancorato a un punto invisibile accanto alla barra, creato una volta
// sola e riempito a ogni apertura (menu delle icone di sistema e cassetto).
class AnchoredMenu {
    constructor(ext) {
        this._ext = ext;
        this._anchor = new St.Widget({width: 1, height: 1, opacity: 0});
        Main.uiGroup.add_child(this._anchor);
        this._manager = new PopupMenu.PopupMenuManager(this._anchor);
        this._menu = null;
        this._side = null;
    }

    async open(x, y, fill) {
        const side = popupSide(this._ext.side);
        this._menu?.close({animate: false});
        if (this._menu && this._side !== side) {
            this._menu.destroy();
            this._menu = null;
        }
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this._anchor, 0.5, side);
            this._menu.actor.add_style_class_name('barra-tray-menu');
            Main.uiGroup.add_child(this._menu.actor);
            this._manager.addMenu(this._menu);
            this._menu.actor.hide();
            this._side = side;
            this._menu.connect('open-state-changed', (_m, open) => {
                if (!open)
                    this._ext.nudgeAutohide();
            });
        }
        const menu = this._menu;
        menu.removeAll();
        // Lo stesso menu fa da cassetto o da menu di un'app: si riparte neutri.
        menu.actor.remove_style_class_name('barra-drawer-menu');
        this._anchor.set_position(x, y);
        const token = this._token = (this._token ?? 0) + 1;
        const valid = () => !this._destroyed && token === this._token && menu === this._menu;
        let ok = false;
        try {
            ok = await fill(menu, valid);
        } catch {}
        if (ok && valid() && !menu.isEmpty())
            menu.open();
    }

    destroy() {
        this._destroyed = true;
        this._menu?.close({animate: false});
        this._menu?.destroy();
        this._menu = null;
        this._anchor.destroy();
    }
}

class InfoPopup {
    constructor(ext) {
        this._ext = ext;
        this._anchor = new St.Widget({width: 1, height: 1, opacity: 0});
        Main.uiGroup.add_child(this._anchor);
        this._manager = new PopupMenu.PopupMenuManager(this._anchor);
        this._menu = null;
    }

    // Il menu si crea una volta sola e si riempie di nuovo a ogni apertura:
    // niente da distruggere a metà di un'animazione. Si ricrea solo se cambia
    // il lato da cui deve aprirsi (e intanto è chiuso).
    _ensureMenu(side) {
        if (this._menu && (this._menuSide !== side) && !this._menu.isOpen) {
            this._menu.destroy();
            this._menu = null;
        }
        if (this._menu)
            return this._menu;
        const menu = new PopupMenu.PopupMenu(this._anchor, 0.5, side);
        menu.actor.add_style_class_name('barra-info');
        Main.uiGroup.add_child(menu.actor);
        this._manager.addMenu(menu);
        menu.actor.hide();
        this._menu = menu;
        this._menuSide = side;
        menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                this._ext.nudgeAutohide();
        });
        return menu;
    }

    open(x, y) {
        const ext = this._ext;
        const settings = ext.getSettings();
        this._menu?.close({animate: false});
        this._anchor.set_position(x, y);
        const menu = this._ensureMenu(popupSide(ext.side));
        menu.removeAll();
        setClass(menu.actor, 'light', ext.light);

        // Intestazione: logo, nome, versione e una riga di descrizione.
        const head = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        // Non è una voce disattivata: niente testo spento.
        head.remove_style_pseudo_class('insensitive');
        const logo = ext.dir.get_child('icons').get_child('barretta.svg');
        this._hasLogo ??= logo.query_exists(null);
        if (this._hasLogo) {
            head.add_child(new St.Icon({
                gicon: new Gio.FileIcon({file: logo}),
                icon_size: 44,
                style_class: 'barra-info-logo',
            }));
        }
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({style_class: 'barra-info-title', text: ext.metadata.name}));
        text.add_child(new St.Label({style_class: 'barra-info-subtitle', text: _('A light app bar: zero calories for your CPU.')}));
        text.add_child(new St.Label({style_class: 'barra-info-subtitle', text: _('Version %s').format(`${ext.metadata.version ?? 1}`)}));
        head.add_child(text);
        menu.addMenuItem(head);

        // Dimensione: cursore a scatti con le tacche sotto.
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Bar size')));
        const n = SIZES.length;
        let current = settings.get_int('bar-size');
        const sizeItem = new PopupMenu.PopupBaseMenuItem({activate: false, style_class: 'barra-info-size'});
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const slider = new Slider.Slider(current / (n - 1));
        slider.x_expand = true;
        slider.accessible_name = _('Bar size');
        for (let i = 0; i < n; i++)
            slider.addMark(i / (n - 1));
        column.add_child(slider);
        // Tacche disegnate esattamente sotto le posizioni della maniglia.
        const ticks = new St.DrawingArea({style_class: 'barra-info-ticks', x_expand: true, height: 8});
        ticks.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            const k = h / 8;
            const r = slider.get_theme_node().get_length('-slider-handle-radius') * k;
            const c = area.get_theme_node().get_foreground_color();
            cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255);
            cr.setLineWidth(1.5 * k);
            for (let i = 0; i < n; i++) {
                const tx = Math.round(r + i * (w - 2 * r) / (n - 1)) + 0.5;
                cr.moveTo(tx, 0);
                cr.lineTo(tx, i === current ? h : h * 0.55);
            }
            cr.stroke();
            cr.$dispose();
        });
        column.add_child(ticks);
        const labels = new St.BoxLayout({x_expand: true});
        labels.add_child(new St.Label({style_class: 'barra-info-tick-label', text: _('Small'), x_expand: true}));
        labels.add_child(new St.Label({style_class: 'barra-info-tick-label', text: _('Large')}));
        column.add_child(labels);
        sizeItem.add_child(column);
        menu.addMenuItem(sizeItem);
        slider.connect('notify::value', () => {
            const i = Math.round(slider.value * (n - 1));
            if (i === current)
                return;
            current = i;
            ticks.queue_repaint();
            settings.set_int('bar-size', i);
        });
        // Lasciando la maniglia, si aggancia allo scatto più vicino.
        slider.connect('drag-end', () => {
            slider.value = current / (n - 1);
        });

        // Lato: due pulsanti, uno acceso.
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Position')));
        const sideItem = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        const choices = new St.BoxLayout({style_class: 'barra-info-choices', x_expand: true});
        for (const [value, label] of [['left', _('Left')], ['bottom', _('Bottom')], ['right', _('Right')]]) {
            const button = new St.Button({
                style_class: 'button barra-info-choice',
                label,
                x_expand: true,
                can_focus: true,
                toggle_mode: true,
                checked: ext.side === value,
            });
            button.connect('clicked', () => {
                if (ext.side !== value)
                    settings.set_string('side', value);
                menu.close();
            });
            choices.add_child(button);
        }
        sideItem.add_child(choices);
        menu.addMenuItem(sideItem);

        // Area di sistema: niente, cassetto, visibili (e quante).
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('System tray')));
        const trayMode = settings.get_string('tray');
        const choiceRow = (entries, isOn, onPick) => {
            const row = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
            const box = new St.BoxLayout({style_class: 'barra-info-choices', x_expand: true});
            for (const [value, text] of entries) {
                const button = new St.Button({
                    style_class: 'button barra-info-choice',
                    label: text,
                    x_expand: true,
                    can_focus: true,
                    toggle_mode: true,
                    checked: isOn(value),
                });
                button.connect('clicked', () => onPick(value));
                box.add_child(button);
            }
            row.add_child(box);
            menu.addMenuItem(row);
        };
        // Dopo una scelta la finestrella si ridisegna al suo posto.
        const reopen = () => {
            if (this._reopenId)
                GLib.source_remove(this._reopenId);
            this._reopenId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._reopenId = 0;
                this.open(x, y);
                return GLib.SOURCE_REMOVE;
            });
        };
        choiceRow([['none', _('Off')], ['drawer', _('Drawer')], ['inline', _('Visible')]],
            v => v === trayMode, v => {
                settings.set_string('tray', v);
                reopen();
            });
        if (trayMode === 'inline') {
            const label = new PopupMenu.PopupMenuItem(_('Visible icons'), {reactive: false, can_focus: false});
            label.remove_style_pseudo_class('insensitive');
            label.add_style_class_name('barra-info-sublabel');
            menu.addMenuItem(label);
            const max = settings.get_int('tray-max');
            const counts = [];
            for (let i = 1; i <= TRAY_MAX_CHOICES; i++)
                counts.push([i, `${i}`]);
            counts.push([0, _('All')]);
            choiceRow(counts, v => v === max, v => {
                settings.set_int('tray-max', v);
                reopen();
            });
        }

        // Nascondimento automatico, spento di default.
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const autohide = new PopupMenu.PopupSwitchMenuItem(_('Hide automatically'), settings.get_boolean('autohide'));
        autohide.connect('toggled', (_i, on) => settings.set_boolean('autohide', on));
        menu.addMenuItem(autohide);

        menu.open();
    }

    destroy() {
        if (this._reopenId)
            GLib.source_remove(this._reopenId);
        this._reopenId = 0;
        this._menu?.close({animate: false});
        this._menu?.destroy();
        this._menu = null;
        this._anchor.destroy();
    }
}

// ---------------------------------------------------------------------------
// Conteggio delle notifiche per app, da due fonti:
// - LauncherEntry (D-Bus): il numero che le app espongono da sole (Telegram,
//   Thunderbird, Firefox...);
// - le notifiche di GNOME ancora presenti per quell'app.
// Vale il più alto dei due.

class Notifications {
    constructor(onChange) {
        this._onChange = onChange;
        // id app -> {count, countVisible, progress, progressVisible}: lo stato
        // LauncherEntry di ogni app; gli aggiornamenti possono essere parziali.
        this._entries = new Map();
        this._trayCounts = null;      // id app -> notifiche, ricalcolato una volta per aggiornamento
        this._signalId = Gio.DBus.session.signal_subscribe(
            null, 'com.canonical.Unity.LauncherEntry', 'Update', null, null,
            Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => this._onLauncherUpdate(params));

        Main.messageTray.connectObject(
            'source-added', (_t, source) => this._watchSource(source),
            'source-removed', (_t, source) => {
                source.disconnectObject(this);
                this._changed();
            }, this);
        for (const source of Main.messageTray.getSources())
            this._watchSource(source);
    }

    _changed() {
        this._trayCounts = null;
        this._onChange();
    }

    // Segnali da qualunque processo: tipo controllato, solo app che esistono,
    // numeri sensati, e si avvisa solo se qualcosa cambia davvero.
    _onLauncherUpdate(params) {
        if (params.get_type_string() !== '(sa{sv})')
            return;
        let uri, props;
        try {
            [uri, props] = params.recursiveUnpack();
        } catch {
            return;
        }
        if (typeof uri !== 'string' || !props || typeof props !== 'object')
            return;
        const id = uri.replace(/^application:\/\//, '');
        if (!Shell.AppSystem.get_default().lookup_app(id))
            return;
        const old = this._entries.get(id) ?? {count: 0, countVisible: false, progress: 0, progressVisible: false};
        const next = {...old};
        if (Number.isFinite(props.count))
            next.count = Math.max(0, Math.floor(props.count));
        if (typeof props['count-visible'] === 'boolean')
            next.countVisible = props['count-visible'];
        if (Number.isFinite(props.progress))
            next.progress = Math.max(0, Math.min(1, props.progress));
        if (typeof props['progress-visible'] === 'boolean')
            next.progressVisible = props['progress-visible'];
        if (next.count === old.count && next.countVisible === old.countVisible &&
            next.progress === old.progress && next.progressVisible === old.progressVisible)
            return;
        this._entries.set(id, next);
        this._onChange();
    }

    _watchSource(source) {
        source.connectObject(
            'notification-added', () => this._changed(),
            'notification-removed', () => this._changed(), this);
        this._changed();
    }

    _sourceAppId(source) {
        const app = source.app ?? source._app ?? null;
        if (app)
            return app.get_id();
        const policyId = source.policy?.id;
        return policyId ? `${policyId}.desktop` : null;
    }

    // Quando un'app si chiude, il suo stato LauncherEntry non vale più.
    appStopped(id) {
        if (this._entries.delete(id))
            this._onChange();
    }

    progressFor(id) {
        const e = this._entries.get(id);
        return e?.progressVisible ? e.progress : null;
    }

    countFor(id) {
        if (!this._trayCounts) {
            this._trayCounts = new Map();
            for (const source of Main.messageTray.getSources()) {
                const appId = this._sourceAppId(source);
                if (appId)
                    this._trayCounts.set(appId, (this._trayCounts.get(appId) ?? 0) + source.count);
            }
        }
        const e = this._entries.get(id);
        return Math.max(this._trayCounts.get(id) ?? 0, e?.countVisible ? e.count : 0);
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._signalId);
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources())
            source.disconnectObject(this);
        this._entries.clear();
        this._trayCounts = null;
    }
}

// ---------------------------------------------------------------------------

export default class BarraExtension extends Extension {
    enable() {
        this._disabling = false;
        this._autohideOn = undefined;
        this._settings = this.getSettings();
        this._tracker = Shell.WindowTracker.get_default();
        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        this._laterId = 0;
        this._watched = new WeakSet();
        this.bars = [];
        this.preview = new Preview(this);
        this.notifications = new Notifications(() => this._queueUpdate());

        const update = () => this._queueUpdate();
        this._tracker.connectObject(
            'tracked-windows-changed', update,
            'notify::focus-app', update, this);
        this._appSystem.connectObject('app-state-changed', (_s, app) => {
            if (app.get_state() === Shell.AppState.STOPPED) {
                this.notifications.appStopped(app.get_id());
                // Chiusa l'app, non resta più in cima.
                this._onTop.delete(app.get_id());
                // L'app è chiusa: la sua icona tenuta da parte non serve più.
                for (const bar of this.bars)
                    bar.dropSpare(app.get_id());
            }
            update();
        }, this);
        this._favorites.connectObject('changed', update, this);
        global.display.connectObject(
            'notify::focus-window', update,
            'window-entered-monitor', update,
            'window-left-monitor', update,
            'window-demands-attention', update,
            'window-marked-urgent', update,
            'window-created', (_d, w) => {
                this._watchWindow(w);
                update();
            }, this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', update,
            'notify::n-workspaces', update, this);
        Main.layoutManager.connectObject('monitors-changed', () => this._rebuild(), this);
        Main.layoutManager.panelBox.connectObject('notify::height', () => this._relayout(), this);
        Main.overview.connectObject('showing', () => this.preview.hide(), this);
        this._settings.connectObject(
            'changed::side', () => this._rebuild(),
            'changed::all-monitors', () => this._rebuild(),
            'changed::autohide', () => {
                this._autohideOn = this._settings.get_boolean('autohide');
                this._rebuild();
            },
            'changed::tray', () => {
                this._setupTray();
                update();
            },
            'changed::tray-max', update,
            'changed::isolate-workspaces', update,
            'changed::open-only', update,
            'changed::bar-size', () => {
                applySize(this._settings.get_int('bar-size'));
                this._rebuild();
            },
            'changed::app-order', () => {
                this._order = this._settings.get_strv('app-order');
                update();
            }, this);

        this._search = null;
        this._pinned = null;
        this._onTop = new Set();   // solo per questa sessione, non salvato
        this._order = this._settings.get_strv('app-order');
        applySize(this._settings.get_int('bar-size'));
        this.info = new InfoPopup(this);
        this.trayMenu = new AnchoredMenu(this);
        this._trayRevision = 0;
        this._setupTray();
        this.search = new SearchPopup(this);
        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        Main.wm.addKeybinding('search-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            modes, () => this.search.toggle());
        Main.wm.addKeybinding('open-only-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            modes, () => this.toggleOpenOnly());
        Main.wm.addKeybinding('focus-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            modes, () => this.focusBar());
        this._takeAppShortcuts();
        this._dndHoverItem = null;
        this._dndHoverId = 0;
        Main.xdndHandler.connectObject('drag-end', () => this._cancelDndHover(), this);
        // Chiaro o scuro come la shell stessa, non solo come le app.
        St.Settings.get().connectObject('notify::color-scheme', () => this._restyle(), this);

        for (const actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);

        this._rebuild();
    }

    disable() {
        // Da qui in poi niente più aggiornamenti in coda: la distruzione delle
        // barre non deve rimettere in moto nulla dopo la disattivazione.
        this._disabling = true;
        Main.wm.removeKeybinding('search-shortcut');
        Main.wm.removeKeybinding('open-only-shortcut');
        Main.wm.removeKeybinding('focus-shortcut');
        this._giveBackAppShortcuts();
        this._cancelDndHover();
        Main.xdndHandler.disconnectObject(this);
        this.search.destroy();
        this.search = null;
        this.info.destroy();
        this.trayMenu.destroy();
        this.trayMenu = null;
        this.tray?.destroy();
        this.tray = null;
        this.info = null;
        this._search = null;
        this._pinned = null;
        this._onTop = null;
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        if (this._autohideLater)
            global.compositor.get_laters().remove(this._autohideLater);
        this._autohideLater = 0;

        for (const actor of global.get_window_actors())
            actor.meta_window?.disconnectObject(this);
        this._tracker.disconnectObject(this);
        this._appSystem.disconnectObject(this);
        this._favorites.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._settings.disconnectObject(this);
        St.Settings.get().disconnectObject(this);

        this._destroyBars();
        this.preview.destroy();
        this.preview = null;
        this.notifications.destroy();
        this.notifications = null;
        // Di nuovo, dopo la distruzione delle barre, per sicurezza.
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        if (this._autohideLater)
            global.compositor.get_laters().remove(this._autohideLater);
        this._autohideLater = 0;
        this._settings = null;
        this._tracker = null;
        this._appSystem = null;
        this._favorites = null;
        this._watched = null;
    }

    get side() {
        return this._settings.get_string('side');
    }

    get light() {
        return Main.getStyleVariant() === 'light';
    }

    _watchWindow(window) {
        if (!window || this._watched.has(window))
            return;
        this._watched.add(window);
        const update = () => this._queueUpdate();
        // Spostamenti e ridimensionamenti contano solo per il nascondimento
        // automatico: se è spento, il gestore esce subito.
        const moved = () => {
            if (this.autohide)
                this._queueAutohide();
        };
        window.connectObject(
            'position-changed', moved,
            'size-changed', moved,
            'workspace-changed', update,
            'notify::skip-taskbar', update,
            'notify::demands-attention', update,
            'notify::urgent', update,
            'unmanaged', () => window.disconnectObject(this), this);
    }

    queueUpdate() {
        this._queueUpdate();
    }

    // L'area di sistema esiste solo se non è spenta: spenta, Barretta non fa
    // nemmeno da "watcher" e lascia il posto ad altri.
    _setupTray() {
        const want = this._settings.get_string('tray') !== 'none';
        if (want && !this.tray) {
            this.tray = new Tray();
            this.tray.connect('changed', () => {
                this._trayRevision++;
                this._queueUpdate();
            });
        } else if (!want && this.tray) {
            this.tray.destroy();
            this.tray = null;
            this._trayRevision++;
        }
    }

    // Un menu, la ricerca o un'anteprima si sono chiusi: la barra nascosta
    // automaticamente può tornare a nascondersi.
    nudgeAutohide() {
        if (!this._disabling && this.autohide && this.bars?.length)
            this._queueAutohide();
    }

    get autohide() {
        this._autohideOn ??= this._settings.get_boolean('autohide');
        return this._autohideOn;
    }

    // Un solo controllo per fotogramma anche mentre si trascina una finestra.
    _queueAutohide() {
        if (this._autohideLater || this._disabling)
            return;
        this._autohideLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._autohideLater = 0;
            for (const bar of this.bars)
                bar.updateAutohide();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- Super+1…9 e Super+Ctrl+1…9 seguono la barra ----
    // GNOME li lega alle preferite, che non coincidono con la barra quando la
    // stella è spenta o un'app è tenuta all'inizio. Qui si prendono in prestito
    // e alla disattivazione si restituiscono a GNOME.

    _takeAppShortcuts() {
        const settings = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        for (let i = 1; i <= 9; i++) {
            for (const [name, newWindow] of [[`switch-to-application-${i}`, false],
                [`open-new-window-application-${i}`, true]]) {
                Main.wm.removeKeybinding(name);
                Main.wm.addKeybinding(name, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes,
                    () => this._nthApp(i - 1, newWindow));
            }
        }
    }

    _giveBackAppShortcuts() {
        const settings = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        const wm = Main.wm;
        for (let i = 1; i <= 9; i++) {
            for (const [name, handler] of [[`switch-to-application-${i}`, wm._switchToApplication],
                [`open-new-window-application-${i}`, wm._openNewApplicationWindow]]) {
                wm.removeKeybinding(name);
                if (typeof handler === 'function')
                    wm.addKeybinding(name, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes, handler.bind(wm));
            }
        }
    }

    // L'n-esima icona della barra sullo schermo dove si sta lavorando, nello
    // stesso ordine in cui si vede (prima quelle tenute all'inizio).
    _nthApp(n, newWindow) {
        const current = global.display.get_current_monitor();
        const bar = this.bars.find(b => b.monitorIndex === current) ?? this.bars[0];
        const item = bar?.orderedItems()[n];
        if (!item)
            return;
        Main.overview.hide();
        if (newWindow)
            item.app.open_new_window(-1);
        else
            activateApp(item.app, item.windows);
    }

    // ---- tastiera: Super+B (o Ctrl+Alt+Tab, "Barretta") porta il fuoco sulla barra ----
    focusBar() {
        const current = global.display.get_current_monitor();
        const bar = this.bars.find(b => b.monitorIndex === current) ?? this.bars[0];
        bar?.focus();
    }

    // ---- file trascinati da un'altra app ----
    // Un file trascinato da un'altra app si ferma sopra un'icona: quattro
    // tratti girano per mezzo secondo (un secondo se l'app è chiusa e va
    // aperta); alla fine la piastrella lampeggia e la
    // finestra dell'app viene in primo piano (o l'app si apre, se è chiusa),
    // così il file si lascia lì. Se il file se ne va prima, si annulla.
    dndHover(item) {
        if (this._dndHoverItem === item)
            return;
        this._cancelDndHover();
        this._dndHoverItem = item;
        const count = item.windows.length + item.elsewhere.length;
        // Più finestre: le anteprime subito, e il conto si fa su quella scelta.
        if (count > 1) {
            this.preview.showForDrag(item);
            this._dndWatch(() => this._pointerOver(item.actor) ||
                (this.preview.dragItem === item && this._pointerOver(this.preview.actor)));
            return;
        }
        // Un'app chiusa va aperta: si aspetta di più, per non aprirla per sbaglio.
        const delay = count > 0 ? DND_HOVER_DELAY : DND_HOVER_DELAY_CLOSED;
        item.setDndCountdown(delay);
        const over = () => this._pointerOver(item.actor);
        this._dndWatch(over);
        this._dndHoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._dndHoverId = 0;
            if (!over()) {
                this._cancelDndHover();
                return GLib.SOURCE_REMOVE;
            }
            item.flash();
            if (count > 0)
                activate(item.windows[0] ?? item.elsewhere[0]);
            else
                item.app.activate();
            // Resta "fatto" finché il file non esce: niente nuovo conto.
            item.setDndCountdown(0);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Il file passa sopra un'anteprima: mezzo secondo, poi quella finestra
    // davanti. Le anteprime restano aperte finché il file non esce, così se
    // era quella sbagliata se ne sceglie un'altra.
    dndPreviewHover(entry) {
        if (!this._dndHoverItem || this._dndEntry === entry || this._dndChosen === entry)
            return;
        this._cancelDndEntry();
        this._dndEntry = entry;
        entry._ring.start(DND_HOVER_DELAY);
        this._dndEntryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DND_HOVER_DELAY, () => {
            this._dndEntryId = 0;
            const window = entry._window;
            const chosen = !entry._gone && this._pointerOver(entry);
            this._cancelDndEntry();
            if (chosen && alive(window)) {
                activate(window);
                this._dndChosen = entry;
                this.preview.markActive(entry);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDndEntry() {
        if (this._dndEntryId)
            GLib.source_remove(this._dndEntryId);
        this._dndEntryId = 0;
        // L'anteprima può essere già stata chiusa (e la voce distrutta).
        if (this._dndEntry && !this._dndEntry._gone)
            this._dndEntry._ring.stop();
        this._dndEntry = null;
    }

    _pointerOver(actor) {
        if (!actor)
            return false;
        const [px, py] = global.get_pointer();
        const under = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, px, py);
        return !!under && (under === actor || actor.contains(under));
    }

    // Solo durante un trascinamento: se il file resta fuori da dove serve per
    // più di DND_LEAVE_GRACE (non per i pochi pixel tra icona e anteprime), si
    // annulla tutto.
    _dndWatch(stillOver) {
        if (this._dndWatchId)
            GLib.source_remove(this._dndWatchId);
        let outside = 0;
        this._dndWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DND_WATCH_INTERVAL, () => {
            outside = stillOver() ? 0 : outside + DND_WATCH_INTERVAL;
            if (outside <= DND_LEAVE_GRACE)
                return GLib.SOURCE_CONTINUE;
            this._dndWatchId = 0;
            this._cancelDndHover();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancelDndHover(item) {
        if (this._dndHoverItem === item)
            this._cancelDndHover();
    }

    _cancelDndHover() {
        if (this._dndHoverId)
            GLib.source_remove(this._dndHoverId);
        this._dndHoverId = 0;
        if (this._dndWatchId)
            GLib.source_remove(this._dndWatchId);
        this._dndWatchId = 0;
        this._cancelDndEntry();
        this._dndChosen = null;
        if (this._dndHoverItem && this.preview?.dragItem === this._dndHoverItem)
            this.preview.hide();
        this._dndHoverItem?.setDndCountdown(0);
        this._dndHoverItem = null;
    }

    // Nuovo ordine dopo un trascinamento. Le app che non erano in vista
    // mantengono la loro posizione relativa in coda. Le preferite seguono lo
    // stesso ordine anche in GNOME, così Super+1…9 corrisponde alla barra.
    // Sposta un'app nell'ordine completo (anche le app non visibili ora),
    // prima di `beforeId` oppure dopo `afterId`. Si salvano solo app vere (con
    // un .desktop) e ancora installate. Le preferite seguono lo stesso ordine
    // in GNOME (Super+1…9), con una sola scrittura.
    moveInOrder(movedId, beforeId, afterId, fullIds) {
        const appSystem = this._appSystem;
        const known = id => !!appSystem.lookup_app(id)?.get_app_info();
        let order = [...(fullIds ?? []), ...this._order];
        order = order.filter((id, i) => order.indexOf(id) === i && id !== movedId && known(id));
        let at = beforeId ? order.indexOf(beforeId) : -1;
        if (at < 0)
            at = afterId && order.includes(afterId) ? order.indexOf(afterId) + 1 : order.length;
        if (known(movedId))
            order.splice(at, 0, movedId);
        this._order = order;
        this._settings.set_strv('app-order', order);

        const current = global.settings.get_strv('favorite-apps');
        const favs = new Set(current);
        const sorted = [...order.filter(id => favs.has(id)), ...current.filter(id => !order.includes(id))];
        if (sorted.join('|') !== current.join('|'))
            global.settings.set_strv('favorite-apps', sorted);
    }

    isKeptOnTop(id) {
        return this._onTop.has(id);
    }

    toggleKeepOnTop(id) {
        if (!this._onTop.delete(id))
            this._onTop.add(id);
        this._queueUpdate();
    }

    toggleOpenOnly() {
        this._settings.set_boolean('open-only', !this._settings.get_boolean('open-only'));
    }

    // Parole cercate mentre il riquadro è aperto (già normalizzate) o null.
    setSearch(tokens) {
        this._search = tokens;
        this._queueUpdate();
    }

    get pinnedSearch() {
        return this._pinned;
    }

    pinSearch(text, tokens) {
        this._pinned = {text, tokens};
        this._queueUpdate();
    }

    clearPinnedSearch() {
        this._pinned = null;
        this._queueUpdate();
    }

    _destroyBars() {
        this.search?.close();
        this.preview?.hide();
        for (const bar of this.bars)
            bar.destroy();
        this.bars = [];
    }

    _rebuild() {
        this._destroyBars();
        const monitors = Main.layoutManager.monitors;
        const indexes = (this._settings.get_boolean('all-monitors')
            ? monitors.map((_m, i) => i)
            : [Main.layoutManager.primaryIndex]).filter(i => i >= 0 && monitors[i]);
        this.bars = indexes.map(i => new Bar(this, i));
        this._restyle();
        this._update();
    }

    _relayout() {
        for (const bar of this.bars)
            bar.relayout();
        this._queueUpdate();
    }

    _restyle() {
        for (const bar of this.bars)
            bar.setLight(this.light);
    }

    // Tutti i segnali confluiscono qui: un solo aggiornamento per frame.
    _queueUpdate() {
        if (this._laterId || this._disabling)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        const allMonitors = this._settings.get_boolean('all-monitors');
        const isolate = this._settings.get_boolean('isolate-workspaces');
        const openOnly = this._settings.get_boolean('open-only');
        const workspace = global.workspace_manager.get_active_workspace();
        const focus = global.display.focus_window;

        // Tutte le finestre "da barra", divise per app, una volta sola.
        const allByApp = new Map();
        for (const actor of global.get_window_actors()) {
            const w = actor.meta_window;
            if (!w || w.skip_taskbar)
                continue;
            const app = this._tracker.get_window_app(w);
            if (!app)
                continue;
            if (!allByApp.has(app))
                allByApp.set(app, []);
            allByApp.get(app).push(w);
        }
        for (const list of allByApp.values())
            list.sort(byMonitorThenSequence);

        const rank = new Map(this._order.map((id, i) => [id, i]));
        const favorites = this._favorites.getFavorites();
        const favoriteIds = new Set(favorites.map(a => a.get_id()));

        for (const bar of this.bars) {
            const isHere = w =>
                (!allMonitors || w.get_monitor() === bar.monitorIndex) &&
                (!isolate || w.located_on_workspace(workspace));

            const split = app => {
                const all = allByApp.get(app) ?? [];
                return {
                    app,
                    windows: all.filter(isHere),
                    elsewhere: all.filter(w => !isHere(w)),
                };
            };

            // Preferite in testa nell'ordine di GNOME, poi le altre con finestre
            // qui, nell'ordine in cui sono state aperte: le icone non si spostano.
            // Il riquadro aperto ha la precedenza sul filtro fissato.
            const search = this._search ?? this._pinned?.tokens ?? null;
            const entries = favorites.map(split);
            const others = [...allByApp.keys()]
                .filter(app => !favoriteIds.has(app.get_id()))
                .map(split)
                // Durante una ricerca compaiono anche le app aperte solo altrove.
                .filter(e => e.windows.length > 0 || (search && e.elsewhere.length > 0))
                .sort((a, b) =>
                    Math.min(...[...a.windows, ...a.elsewhere].map(w => w.get_stable_sequence())) -
                    Math.min(...[...b.windows, ...b.elsewhere].map(w => w.get_stable_sequence())));

            let list = [...entries, ...others];
            // Ordine scelto trascinando: chi è in elenco va nella sua posizione,
            // le app nuove (mai spostate) in fondo, nell'ordine di sempre.
            if (this._order.length > 0) {
                list = list
                    .map((e, i) => [e, rank.get(e.app.get_id()) ?? 1e6 + i])
                    .sort((a, b) => a[1] - b[1])
                    .map(([e]) => e);
            }
            // L'ordine completo, anche delle app che i filtri nascondono: serve
            // al trascinamento per non spostare quelle che non si vedono.
            bar._fullIds = list.map(e => e.app.get_id());
            // Solo app aperte: via le preferite che non hanno finestre da nessuna parte.
            if (openOnly || search)
                list = list.filter(e => e.windows.length + e.elsewhere.length > 0);
            if (search) {
                list = list.filter(e =>
                    [...e.windows, ...e.elsewhere].some(w => windowMatches(w, e.app, search)));
            }

            bar.update(list, focus);
            bar.setOpenOnly(openOnly);
            bar.setSearching(this.search?.isOpen ?? false, this._pinned?.text ?? null);
            bar.updateWorkspaces();
            bar.updateAutohide();
            bar.updateTray(this.tray?.items ?? [], this._settings.get_string('tray'),
                this._settings.get_int('tray-max'), this._trayRevision);
        }
    }
}
