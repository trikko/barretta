// Area di sistema per Barretta: le icone che le app mettono "nel vassoio"
// (Dropbox, Discord, Steam, Nextcloud…), con il protocollo StatusNotifierItem
// (AppIndicator) e i loro menu (DBusMenu).
//
// - Se nessuno fa già da "watcher", Barretta lo diventa e le app registrano
//   qui le loro icone.
// - Se un altro lo fa già (un'altra estensione, KDE…), Barretta lo ascolta
//   soltanto: niente conflitti.
// - Nessun lavoro a riposo: si aggiorna solo quando un'app cambia davvero
//   icona o stato.
//
// Sicurezza: tutto ciò che arriva da D-Bus viene da processi qualunque
// dell'utente, quindi è trattato come non fidato. Niente I/O sincrono sul
// thread della shell, dimensioni e quantità limitate, tipi controllati.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';
const ITEM_IFACE = 'org.kde.StatusNotifierItem';
const ITEM_PATH = '/StatusNotifierItem';
const MENU_IFACE = 'com.canonical.dbusmenu';

const REFRESH_DELAY = 100;          // ms: più segnali ravvicinati, un solo aggiornamento
const MAX_ITEMS = 64;               // icone in tutto
const MAX_ITEMS_PER_SENDER = 10;    // icone registrate da uno stesso processo
const MAX_PIXMAP_SIDE = 256;        // px
const MAX_PROP_BYTES = 512 * 1024;  // una proprietà più grande viene ignorata
const MAX_ICON_FILE = 2 * 1024 * 1024;
const MAX_MENU_ITEMS = 150;
const MAX_MENU_DEPTH = 8;
const ICON_CACHE_SIZE = 200;

const WATCHER_XML = `<node>
  <interface name="${WATCHER_NAME}">
    <method name="RegisterStatusNotifierItem"><arg type="s" direction="in" name="service"/></method>
    <method name="RegisterStatusNotifierHost"><arg type="s" direction="in" name="service"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
  </interface>
</node>`;

function call(bus, path, iface, method, params = null, replyType = null) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(bus, path, iface, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, 5000, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
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

const str = v => (typeof v === 'string' ? v : '');

// "bus/percorso" (o solo "bus") -> [bus, percorso]
function splitService(service) {
    service = str(service);
    const i = service.indexOf('/');
    return i > 0 ? [service.slice(0, i), service.slice(i)] : [service, ITEM_PATH];
}

function validService(bus, path) {
    return Gio.dbus_is_name(bus) && GLib.variant_is_object_path(path);
}

// ---- icone: cache condivisa (cartella+nome -> file trovato o null) ----

const iconCache = new Map();

function cacheSet(key, value) {
    iconCache.delete(key);
    iconCache.set(key, value);
    if (iconCache.size > ICON_CACHE_SIZE)
        iconCache.delete(iconCache.keys().next().value);
}

// Un file d'icona è accettato solo se è un file normale e non enorme.
async function usableFile(file) {
    const info = await queryInfo(file, 'standard::type,standard::size');
    return info && info.get_file_type() === Gio.FileType.REGULAR && info.get_size() <= MAX_ICON_FILE;
}

// Icona per nome nella cartella indicata dall'app (IconThemePath): solo un
// piccolo elenco fisso di posizioni, mai una ricerca ricorsiva.
async function findInThemePath(dir, name) {
    if (!GLib.path_is_absolute(dir) || !name || name.includes('/') || name.includes('..'))
        return null;
    const key = `${dir}\u0000${name}`;
    if (iconCache.has(key))
        return iconCache.get(key);
    const candidates = [];
    for (const ext of ['svg', 'png'])
        candidates.push([dir, `${name}.${ext}`]);
    for (const size of ['scalable', '48x48', '32x32', '24x24', '22x22', '16x16']) {
        for (const kind of ['apps', 'status', 'panel']) {
            for (const ext of ['svg', 'png'])
                candidates.push([dir, 'hicolor', size, kind, `${name}.${ext}`]);
        }
    }
    let found = null;
    for (const parts of candidates) {
        const file = Gio.File.new_for_path(GLib.build_filenamev(parts));
        if (await usableFile(file)) {
            found = file;
            break;
        }
    }
    cacheSet(key, found);
    return found;
}

// Immagine grezza ARGB (ordine di rete) -> GdkPixbuf RGBA, scegliendo la
// misura più vicina a quella che serve. Dimensioni e lunghezza controllate.
function pixmapIcon(pixmaps, size = 32) {
    if (!Array.isArray(pixmaps))
        return null;
    const valid = pixmaps.filter(p => Array.isArray(p) && p.length === 3 &&
        Number.isInteger(p[0]) && Number.isInteger(p[1]) &&
        p[0] >= 1 && p[1] >= 1 && p[0] <= MAX_PIXMAP_SIDE && p[1] <= MAX_PIXMAP_SIDE &&
        p[2]?.length >= p[0] * p[1] * 4);
    if (valid.length === 0)
        return null;
    const [w, h, data] = valid.sort((a, b) => Math.abs(a[0] - size) - Math.abs(b[0] - size))[0];
    const n = w * h * 4;
    const rgba = new Uint8Array(n);
    for (let i = 0; i < n; i += 4) {
        rgba[i] = data[i + 1];
        rgba[i + 1] = data[i + 2];
        rgba[i + 2] = data[i + 3];
        rgba[i + 3] = data[i];
    }
    return Shell.util_create_pixbuf_from_data(rgba, GdkPixbuf.Colorspace.RGB, true, 8, w, h, w * 4);
}

// Firma breve di un'immagine grezza, per sapere se è cambiata senza confrontarla tutta.
function pixmapSignature(pixmaps) {
    if (!Array.isArray(pixmaps))
        return '';
    return pixmaps.map(p => {
        const d = p?.[2];
        let hash = 0;
        if (d?.length) {
            const step = Math.max(1, Math.floor(d.length / 64));
            for (let i = 0; i < d.length; i += step)
                hash = (hash * 31 + d[i]) | 0;
        }
        return `${p?.[0]}x${p?.[1]}:${d?.length ?? 0}:${hash}`;
    }).join(',');
}

// Proprietà lette dalla risposta GetAll una per una: quelle troppo grandi si
// saltano senza nemmeno spacchettarle; i tipi si normalizzano.
function readProps(reply) {
    const dict = reply.get_child_value(0);
    const raw = {};
    for (let i = 0; i < dict.n_children(); i++) {
        const entry = dict.get_child_value(i);
        const key = entry.get_child_value(0).get_string()[0];
        const value = entry.get_child_value(1).get_variant();
        if (value.get_size() > MAX_PROP_BYTES)
            continue;
        try {
            raw[key] = value.recursiveUnpack();
        } catch {}
    }
    const tooltip = Array.isArray(raw.ToolTip) ? raw.ToolTip : [];
    return {
        Id: str(raw.Id),
        Title: str(raw.Title),
        Status: ['Passive', 'Active', 'NeedsAttention'].includes(raw.Status) ? raw.Status : 'Active',
        IconName: str(raw.IconName),
        AttentionIconName: str(raw.AttentionIconName),
        IconThemePath: str(raw.IconThemePath),
        IconPixmap: Array.isArray(raw.IconPixmap) ? raw.IconPixmap : [],
        AttentionIconPixmap: Array.isArray(raw.AttentionIconPixmap) ? raw.AttentionIconPixmap : [],
        Menu: GLib.variant_is_object_path(str(raw.Menu)) ? raw.Menu : '',
        ItemIsMenu: raw.ItemIsMenu === true,
        ToolTipTitle: str(tooltip[2]),
    };
}

// ---------------------------------------------------------------------------

export class TrayItem extends EventEmitter {
    constructor(bus, path) {
        super();
        this.bus = bus;
        this.path = path;
        this.key = `${bus}${path}`;
        this.props = null;
        this.icon = null;
        this._iconSig = '';
        this._sig = '';
        this._refreshId = 0;
        this._refreshing = false;
        this._dirty = false;
        this._destroyed = false;
        // Solo i segnali che cambiano qualcosa di visibile; il tooltip no.
        this._signalId = Gio.DBus.session.signal_subscribe(bus, ITEM_IFACE, null, path, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, name) => {
                if (name !== 'NewToolTip')
                    this._refreshSoon();
            });
        this._refresh();
    }

    get title() {
        return this.props?.Title || this.props?.ToolTipTitle || this.props?.Id || '';
    }

    get status() {
        return this.props?.Status ?? 'Active';
    }

    get needsAttention() {
        return this.status === 'NeedsAttention';
    }

    get menuPath() {
        const path = this.props?.Menu;
        return path && path !== '/' ? path : null;
    }

    get itemIsMenu() {
        return !!this.props?.ItemIsMenu;
    }

    get ready() {
        return this.props !== null && this.icon !== null;
    }

    _refreshSoon() {
        if (this._refreshId || this._destroyed)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Rilegge le proprietà; avvisa solo se è cambiato qualcosa di visibile.
    async _refresh() {
        if (this._refreshing) {
            this._dirty = true;
            return;
        }
        this._refreshing = true;
        try {
            const reply = await call(this.bus, this.path, 'org.freedesktop.DBus.Properties', 'GetAll',
                new GLib.Variant('(s)', [ITEM_IFACE]), '(a{sv})');
            if (this._destroyed)
                return;
            const p = readProps(reply);
            const attention = p.Status === 'NeedsAttention';
            const iconSig = [attention ? p.AttentionIconName || p.IconName : p.IconName, p.IconThemePath,
                pixmapSignature(attention && p.AttentionIconPixmap.length ? p.AttentionIconPixmap : p.IconPixmap)].join('|');
            const sig = [iconSig, p.Status, p.Title, p.ToolTipTitle, p.Menu, p.ItemIsMenu].join('|');
            this.props = p;
            if (iconSig !== this._iconSig || !this.icon) {
                this._iconSig = iconSig;
                const icon = await this._resolveIcon(p);
                if (this._destroyed)
                    return;
                this.icon = icon;
            }
            if (sig !== this._sig) {
                this._sig = sig;
                this.emit('changed');
            }
        } catch {
        } finally {
            this._refreshing = false;
            if (this._dirty && !this._destroyed) {
                this._dirty = false;
                this._refreshSoon();
            }
        }
    }

    async _resolveIcon(p) {
        const attention = p.Status === 'NeedsAttention';
        const name = (attention && p.AttentionIconName) || p.IconName;
        if (name) {
            if (GLib.path_is_absolute(name)) {
                const file = Gio.File.new_for_path(name);
                if (await usableFile(file))
                    return new Gio.FileIcon({file});
            } else {
                const file = p.IconThemePath ? await findInThemePath(p.IconThemePath, name) : null;
                return file ? new Gio.FileIcon({file}) : new Gio.ThemedIcon({name});
            }
        }
        let pixbuf = null;
        try {
            pixbuf = pixmapIcon(attention && p.AttentionIconPixmap.length ? p.AttentionIconPixmap : p.IconPixmap);
        } catch {}
        return pixbuf ?? new Gio.ThemedIcon({name: 'image-missing'});
    }

    _call(method, params) {
        call(this.bus, this.path, ITEM_IFACE, method, params).catch(() => {});
    }

    activate(x, y) {
        this._call('Activate', new GLib.Variant('(ii)', [Math.round(x), Math.round(y)]));
    }

    secondaryActivate(x, y) {
        this._call('SecondaryActivate', new GLib.Variant('(ii)', [Math.round(x), Math.round(y)]));
    }

    contextMenu(x, y) {
        this._call('ContextMenu', new GLib.Variant('(ii)', [Math.round(x), Math.round(y)]));
    }

    scroll(delta, orientation) {
        this._call('Scroll', new GLib.Variant('(is)', [Math.round(delta), orientation]));
    }

    // Riempie un menu di GNOME con il menu dell'app (DBusMenu). `valid()` dice
    // se il menu è ancora quello giusto: se nel frattempo se n'è aperto un
    // altro, la risposta lenta di quest'app viene scartata.
    async fillMenu(menu, valid = () => true) {
        const path = this.menuPath;
        if (!path)
            return false;
        try {
            await call(this.bus, path, MENU_IFACE, 'AboutToShow', new GLib.Variant('(i)', [0]));
        } catch {}
        if (!valid())
            return false;
        let root;
        try {
            const res = await call(this.bus, path, MENU_IFACE, 'GetLayout',
                new GLib.Variant('(iias)', [0, MAX_MENU_DEPTH, []]), '(u(ia{sv}av))');
            if (!valid())
                return false;
            root = res.get_child_value(1);
            if (root.get_size() > MAX_PROP_BYTES * 4)
                return false;
        } catch {
            return false;
        }
        const bus = this.bus;
        const event = id => call(bus, path, MENU_IFACE, 'Event',
            new GLib.Variant('(isvu)', [id, 'clicked', new GLib.Variant('i', 0), global.get_current_time() >>> 0]))
            .catch(() => {});
        try {
            fillFromVariant(menu, root.get_child_value(2), event, {count: 0}, 0);
        } catch {
            return false;
        }
        return true;
    }

    destroy() {
        this._destroyed = true;
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        Gio.DBus.session.signal_unsubscribe(this._signalId);
        this.disconnectAll?.();
    }
}

// Le etichette DBusMenu usano "_" per le scorciatoie: "_Apri" -> "Apri", "__" -> "_".
function cleanLabel(label) {
    return str(label).replace(/__/g, '\u0000').replace(/_/g, '').replace(/\u0000/g, '_').slice(0, 200);
}

// Una proprietà della voce, letta direttamente dal dizionario D-Bus.
function prop(dict, key) {
    const v = dict.lookup_value(key, null);
    if (!v)
        return undefined;
    switch (v.get_type_string()) {
    case 's':
        return v.get_string()[0];
    case 'b':
        return v.get_boolean();
    case 'i':
        return v.get_int32();
    default:
        return undefined;
    }
}

// Dal layout DBusMenu alle voci di un menu GNOME, leggendo la risposta voce
// per voce: ci si ferma al limite senza spacchettare il resto (un'app potrebbe
// mandare un menu enorme). Profondità limitata e tipi controllati.
function fillFromVariant(menu, children, event, counter, depth) {
    const n = children.n_children();
    for (let i = 0; i < n; i++) {
        if (counter.count >= MAX_MENU_ITEMS || depth > MAX_MENU_DEPTH)
            return;
        const node = children.get_child_value(i).get_variant();
        if (node.get_type_string() !== '(ia{sv}av)')
            continue;
        const id = node.get_child_value(0).get_int32();
        const props = node.get_child_value(1);
        const sub = node.get_child_value(2);
        if (prop(props, 'visible') === false)
            continue;
        counter.count++;
        if (prop(props, 'type') === 'separator') {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            continue;
        }
        const label = cleanLabel(prop(props, 'label'));
        let item;
        if (prop(props, 'children-display') === 'submenu' || sub.n_children() > 0) {
            item = new PopupMenu.PopupSubMenuMenuItem(label);
            fillFromVariant(item.menu, sub, event, counter, depth + 1);
        } else {
            const iconName = str(prop(props, 'icon-name'));
            item = iconName && !iconName.includes('/')
                ? new PopupMenu.PopupImageMenuItem(label, iconName)
                : new PopupMenu.PopupMenuItem(label);
            const toggle = prop(props, 'toggle-type');
            if (toggle === 'checkmark' || toggle === 'radio') {
                const on = prop(props, 'toggle-state') === 1;
                item.setOrnament(on
                    ? (toggle === 'radio' ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.CHECK)
                    : PopupMenu.Ornament.NO_DOT);
            }
            item.connect('activate', () => event(id));
        }
        if (prop(props, 'enabled') === false)
            item.setSensitive(false);
        menu.addMenuItem(item);
    }
}

// ---------------------------------------------------------------------------

export class Tray extends EventEmitter {
    constructor() {
        super();
        this._items = new Map();      // chiave -> TrayItem
        this._busWatches = new Map(); // bus -> id
        this._perSender = new Map();  // mittente -> quante icone ha registrato
        this._exported = null;
        this._watcherSignals = [];
        this._destroyed = false;
        this._ownId = Gio.bus_own_name_on_connection(Gio.DBus.session, WATCHER_NAME,
            Gio.BusNameOwnerFlags.NONE,
            () => this._becomeWatcher(),
            () => this._useExternalWatcher());
    }

    // Le icone nell'ordine in cui le app le hanno registrate, solo quelle pronte.
    get items() {
        return [...this._items.values()].filter(i => i.ready);
    }

    // ---- Barretta fa da watcher ----

    _becomeWatcher() {
        if (this._destroyed)
            return;
        this._dropExternal();
        const tray = this;
        const impl = {
            RegisterStatusNotifierItemAsync: ([service], invocation) => {
                const sender = invocation.get_sender();
                let [bus, path] = splitService(service);
                if (str(service).startsWith('/'))
                    [bus, path] = [sender, service];
                this._add(bus, path, sender);
                invocation.return_value(null);
            },
            RegisterStatusNotifierHostAsync: (_params, invocation) => invocation.return_value(null),
            get RegisteredStatusNotifierItems() {
                return tray._keys();
            },
            IsStatusNotifierHostRegistered: true,
            ProtocolVersion: 0,
        };
        this._exported = Gio.DBusExportedObject.wrapJSObject(WATCHER_XML, impl);
        this._exported.export(Gio.DBus.session, WATCHER_PATH);
        this._exported.emit_signal('StatusNotifierHostRegistered', null);
    }

    _keys() {
        return [...this._items.values()].map(i => `${i.bus}${i.path}`);
    }

    // ---- un altro fa già da watcher: lo si ascolta ----

    async _useExternalWatcher() {
        if (this._destroyed)
            return;
        if (this._exported) {
            this._exported.unexport();
            this._exported = null;
        }
        this._dropExternal();
        const conn = Gio.DBus.session;
        const on = (signal, handler) => this._watcherSignals.push(conn.signal_subscribe(
            WATCHER_NAME, WATCHER_NAME, signal, WATCHER_PATH, null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                const [service] = params.deepUnpack();
                handler(str(service));
            }));
        on('StatusNotifierItemRegistered', service => this._add(...splitService(service), null));
        on('StatusNotifierItemUnregistered', service => this._remove(splitService(service).join('')));
        try {
            await call(WATCHER_NAME, WATCHER_PATH, WATCHER_NAME, 'RegisterStatusNotifierHost',
                new GLib.Variant('(s)', [conn.get_unique_name()]));
        } catch {}
        if (this._destroyed)
            return;
        try {
            const res = await call(WATCHER_NAME, WATCHER_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [WATCHER_NAME, 'RegisteredStatusNotifierItems']), '(v)');
            if (this._destroyed)
                return;
            const list = res.recursiveUnpack()[0];
            for (const service of Array.isArray(list) ? list.slice(0, MAX_ITEMS) : [])
                this._add(...splitService(service), null);
        } catch {}
    }

    _dropExternal() {
        for (const id of this._watcherSignals)
            Gio.DBus.session.signal_unsubscribe(id);
        this._watcherSignals = [];
    }

    // ---- icone ----

    _add(bus, path, sender) {
        if (this._destroyed || !validService(bus, path))
            return;
        const key = `${bus}${path}`;
        if (this._items.has(key) || this._items.size >= MAX_ITEMS)
            return;
        // Limite per processo: un'app non può riempire la barra di icone.
        const owner = sender ?? bus;
        if ((this._perSender.get(owner) ?? 0) >= MAX_ITEMS_PER_SENDER)
            return;
        this._perSender.set(owner, (this._perSender.get(owner) ?? 0) + 1);
        const item = new TrayItem(bus, path);
        item.owner = owner;
        item.connect('changed', () => this.emit('changed'));
        this._items.set(key, item);
        this._exported?.emit_signal('StatusNotifierItemRegistered', new GLib.Variant('(s)', [key]));
        // Quando l'app se ne va, la sua icona sparisce.
        if (!this._busWatches.has(bus)) {
            const id = Gio.bus_watch_name_on_connection(Gio.DBus.session, bus,
                Gio.BusNameWatcherFlags.NONE, null, () => this._removeBus(bus));
            if (id)
                this._busWatches.set(bus, id);
        }
    }

    _remove(key) {
        const item = this._items.get(key);
        if (!item)
            return;
        item.destroy();
        this._items.delete(key);
        const left = (this._perSender.get(item.owner) ?? 1) - 1;
        if (left > 0)
            this._perSender.set(item.owner, left);
        else
            this._perSender.delete(item.owner);
        // Niente più icone di quel processo: si smette di osservarlo.
        if (![...this._items.values()].some(i => i.bus === item.bus)) {
            const id = this._busWatches.get(item.bus);
            if (id)
                Gio.bus_unwatch_name(id);
            this._busWatches.delete(item.bus);
        }
        this._exported?.emit_signal('StatusNotifierItemUnregistered', new GLib.Variant('(s)', [key]));
        this.emit('changed');
    }

    _removeBus(bus) {
        for (const item of [...this._items.values()]) {
            if (item.bus === bus)
                this._remove(item.key);
        }
    }

    destroy() {
        this._destroyed = true;
        Gio.bus_unown_name(this._ownId);
        this._exported?.unexport();
        this._exported = null;
        this._dropExternal();
        for (const id of this._busWatches.values())
            Gio.bus_unwatch_name(id);
        this._busWatches.clear();
        for (const item of this._items.values())
            item.destroy();
        this._items.clear();
        this._perSender.clear();
        this.disconnectAll?.();
    }
}
