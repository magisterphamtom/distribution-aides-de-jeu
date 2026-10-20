/**
 * Distribution d'aides de jeu
 * Le Gardien remet un document (image ou page de journal) à un ou plusieurs joueurs :
 * il apparaît chez eux avec une animation, et se range tout seul dans leur journal de bord.
 * Foundry VTT v13 / v14 — magisterphamtom — MIT
 */

import { attachZoom, handleZoomSocket, openImage, zoomEnabled } from "./zoom.js";

const ID = "distribution-aides-de-jeu";
const SOCKET = `module.${ID}`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const active = (id) => !!game.modules.get(id)?.active;
const TextEditorImpl = () => foundry.applications.ux.TextEditor.implementation;

/* ================================================================== */
/*  Réglages                                                           */
/* ================================================================== */

Hooks.once("init", () => {
  game.settings.register(ID, "logbookFolder", {
    name: "Dossier des journaux de bord (1933)",
    hint: "Dossier qui contient un journal par joueur (le joueur en est propriétaire). Laissez vide : le module cherche un dossier dont le nom commence par « Journal de bord ».",
    scope: "world", config: true, type: String, default: ""
  });
  game.settings.register(ID, "logbookFolderModern", {
    name: "Dossier des carnets de bord (2026)",
    hint: "Où ranger les aides de jeu de l'époque moderne. Laissez vide : le module cherche un dossier dont le nom commence par « Carnet de bord » (à défaut, il utilise le dossier 1933).",
    scope: "world", config: true, type: String, default: ""
  });
  game.settings.register(ID, "createLogbook", {
    name: "Créer le journal de bord s'il n'existe pas",
    hint: "Si un joueur n'a pas encore de journal de bord, le module en crée un (à son nom de personnage) dans le dossier des journaux de bord.",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(ID, "theme", {
    name: "Style de l'animation",
    hint: "« Automatique » suit l'époque du module Bascule d'époque.",
    scope: "world", config: true, type: String,
    choices: { auto: "Automatique", "1933": "Années 30 (enveloppe et cachet de cire)", modern: "Moderne (mail reçu avec pièce jointe)" },
    default: "auto"
  });
  game.settings.register(ID, "chatLog", {
    name: "Trace dans le chat",
    hint: "Un message privé (Gardien + destinataires) garde la trace de chaque remise.",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(ID, "sound", {
    name: "Son à la réception",
    hint: "Chemin d'un son joué chez le destinataire (vide : aucun).",
    scope: "world", config: true, type: String, default: "sounds/notify.wav", filePicker: "audio"
  });
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, (data) => {
    try {
      if (handleZoomSocket(data)) return;
      if (data?.type === "handout" && data.users?.includes(game.user.id)) Reveal.show(data);
      else if (data?.type === "fileDone" && data.userId === game.user.id) Reveal.filed(data);
      // Seul le Gardien actif range à la demande d'un joueur (et seulement pour une remise qu'il a faite)
      else if ((data?.type === "fileRequest" || data?.type === "fileSkip") && game.user.isGM && game.users.activeGM?.isSelf) handleChoice(data);
    } catch (err) {
      console.error(`${ID} | réception`, err);
    }
  });
  const mod = game.modules.get(ID);
  if (mod) mod.api = { open: (doc) => DistributeApp.open(doc), openImage: (src, title) => DistributeApp.openImage(src, title), distribute };
});

function era() {
  const t = game.settings.get(ID, "theme");
  if (t === "1933" || t === "modern") return t;
  if (active("coc7-bascule-epoque")) {
    const e = game.settings.get("coc7-bascule-epoque", "currentEra");
    if (e === "modern") return "modern";
  }
  return "1933";
}

/* ================================================================== */
/*  Journaux de bord                                                   */
/* ================================================================== */

/** Époque d'une aide de jeu, d'après les dossiers où elle est rangée (ou le chemin de l'image). */
function eraOf(handout) {
  const test = (txt) => (/20(2[4-9]|3\d)/.test(txt) ? "modern" : /19[23]\d/.test(txt) ? "1933" : null);
  let doc = handout?.uuid ? fromUuidSync(handout.uuid) : null;
  if (doc?.documentName === "JournalEntryPage") doc = doc.parent;
  for (let f = doc?.folder; f; f = f.folder) {
    const e = test(f.name);
    if (e) return e;
  }
  if (handout?.kind === "image" && handout.src) {
    const e = test(decodeURIComponent(handout.src));
    if (e) return e;
  }
  return era();
}

function findFolder(setting, prefix) {
  const wanted = game.settings.get(ID, setting).trim().toLowerCase();
  const folders = game.folders.filter((f) => f.type === "JournalEntry");
  if (wanted) return folders.find((f) => f.name.trim().toLowerCase() === wanted) ?? null;
  return folders.find((f) => f.name.trim().toLowerCase().startsWith(prefix)) ?? null;
}

function logbookFolder(e = "1933") {
  if (e === "modern") return findFolder("logbookFolderModern", "carnet de bord") ?? findFolder("logbookFolder", "journal de bord");
  return findFolder("logbookFolder", "journal de bord");
}

function logbookFor(user, e = "1933") {
  const folder = logbookFolder(e);
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const nameRe = e === "modern" ? /carnet de bord/i : /journal de bord/i;
  const candidates = game.journal.filter((j) =>
    (folder ? j.folder?.id === folder.id : nameRe.test(j.name)) && j.ownership?.[user.id] === OWNER);
  if (candidates.length <= 1) return candidates[0] ?? null;
  const charName = user.character?.name?.toLowerCase();
  return candidates.find((j) => charName && j.name.toLowerCase().includes(charName.split(" ")[0])) ?? candidates[0];
}

/** Recopie des pages dans le journal / carnet de bord d'un joueur. Retourne l'UUID de la première page, ou null. */
async function fileForUser(user, pages, e, note) {
  const book = await ensureLogbook(user, e);
  if (!book) return null;
  const stamp = new Date().toLocaleDateString("fr-FR");
  const created = await book.createEmbeddedDocuments("JournalEntryPage", pages.map((p) => ({
    ...p,
    flags: { ...(p.flags ?? {}), [ID]: { received: stamp, note: note || "" } }
  })));
  return created[0]?.uuid ?? null;
}

/** Ce que le joueur voit d'une page quand rien n'est encore rangé : image ou texte brut. */
function displayOf(page) {
  if (!page) return null;
  if (page.type === "image" && page.src) return { type: "image", src: page.src };
  const html = page.text?.content;
  return html ? { type: "text", html } : null;
}

/** Remises en attente d'un choix du joueur (mémoire du Gardien) : offerId → { users, pages, era, note, title, filed } */
const offers = new Map();

async function ensureLogbook(user, e = "1933") {
  const existing = logbookFor(user, e);
  if (existing || !game.settings.get(ID, "createLogbook")) return existing;
  const folder = logbookFolder(e);
  const name = `${e === "modern" ? "Carnet" : "Journal"} de Bord [${user.character?.name ?? user.name}]`;
  return JournalEntry.create({
    name,
    folder: folder?.id ?? null,
    ownership: { default: 0, [user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
  });
}

/* ================================================================== */
/*  Distribution                                                       */
/* ================================================================== */

/**
 * handout = { kind: "image" | "page" | "entry", title, src?, uuid? }
 * options = { users: [ids], file: bool, reveal: bool, grant: bool, note: string }
 */
async function distribute(handout, options) {
  if (!game.user.isGM) return;
  const users = options.users.map((id) => game.users.get(id)).filter(Boolean);
  if (!users.length) return ui.notifications.warn("Choisissez au moins un destinataire.");
  const hEra = options.era === "1933" || options.era === "modern" ? options.era : eraOf(handout);
  const bookWord = hEra === "modern" ? "carnet de bord" : "journal de bord";

  // Pages à recopier
  let pages = [];
  let source = null;
  if (handout.kind === "image") {
    pages = [{ type: "image", name: handout.title, src: handout.src, image: { caption: options.note || "" } }];
  } else {
    source = await fromUuid(handout.uuid);
    if (!source) return ui.notifications.error("Document introuvable.");
    const list = handout.kind === "entry" ? [...source.pages] : [source];
    pages = list.map((p) => {
      const data = p.toObject();
      delete data._id;
      delete data.ownership;
      if (handout.kind === "page") data.name = handout.title || data.name;
      data.sort = undefined;
      return data;
    });
  }

  // Le joueur décide lui-même de ranger : possible seulement si le document apparaît à l'écran
  const choice = !!(options.file && options.choice && options.reveal);
  const offerId = choice ? foundry.utils.randomID() : null;
  if (choice) offers.set(offerId, { users: users.map((u) => u.id), pages, era: hEra, note: options.note || "", title: handout.title, filed: new Map() });

  const delivered = {};
  const failed = [];
  for (const user of users) {
    let pageUuid = null;
    try {
      // 1. Rangement dans le journal de bord (automatique, sauf si le joueur choisit)
      if (options.file && !choice) {
        pageUuid = await fileForUser(user, pages, hEra, options.note);
        if (!pageUuid) failed.push(`${user.name} (pas de ${bookWord})`);
      }
      // 2. Accès en lecture au document d'origine
      if (options.grant && source) {
        const doc = handout.kind === "page" ? source.parent : source;
        const lvl = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
        if ((doc.ownership?.[user.id] ?? 0) < lvl) await doc.update({ [`ownership.${user.id}`]: lvl });
      }
      delivered[user.id] = pageUuid;
    } catch (err) {
      console.error(`${ID} | remise à ${user.name}`, err);
      failed.push(user.name);
    }
  }

  // 3. Apparition chez les destinataires
  if (options.reveal) {
    const payload = {
      type: "handout",
      users: Object.keys(delivered),
      pages: delivered,
      era: game.settings.get(ID, "theme") === "auto" ? hEra : era(),
      title: handout.title,
      note: options.note || "",
      sender: options.sender || "",
      imgName: handout.preview || handout.src || null,
      kind: handout.kind,
      src: handout.kind === "image" ? handout.src : null,
      sourceUuid: handout.uuid ?? null,
      choice,
      offerId,
      fileEra: hEra,
      display: choice ? displayOf(pages[0]) : null
    };
    game.socket.emit(SOCKET, payload);
    if (options.preview) Reveal.show({ ...payload, users: [game.user.id], preview: true });
  }

  // 4. Trace dans le chat
  if (game.settings.get(ID, "chatLog")) {
    const names = users.filter((u) => u.id in delivered).map((u) => esc(u.character?.name ?? u.name)).join(", ");
    if (names) {
      await ChatMessage.create({
        content: `<div class="dh-chat"><i class="fa-solid fa-envelope-open-text"></i> <b>${esc(handout.title)}</b> remis à ${names}${options.note ? `<br><em>${esc(options.note)}</em>` : ""}${options.file ? `<br><span class="dh-chat-sub">${choice ? `Rangement au choix du joueur (${bookWord}).` : `Rangé dans le ${bookWord}.`}</span>` : ""}</div>`,
        whisper: [...new Set([...game.users.filter((u) => u.isGM).map((u) => u.id), ...Object.keys(delivered)])]
      });
    }
  }

  const ok = Object.keys(delivered).length;
  if (failed.length) ui.notifications.warn(`Remis à ${ok} joueur(s). Problème : ${failed.join(", ")}.`);
  else ui.notifications.info(`« ${handout.title} » remis à ${ok} joueur(s).`);
}

/**
 * Choix du joueur, côté Gardien : « Ranger » crée la copie dans son journal / carnet de bord,
 * « Ne pas ranger » laisse une trace dans le chat. Les pages viennent de la remise gardée en mémoire,
 * jamais du message du joueur.
 */
async function handleChoice(data) {
  const offer = offers.get(data.offerId);
  const user = game.users.get(data.userId);
  const reply = (extra) => game.socket.emit(SOCKET, { type: "fileDone", userId: data.userId, offerId: data.offerId, ...extra });
  const bookWord = offer?.era === "modern" ? "carnet de bord" : "journal de bord";
  const whisper = () => [...new Set([...game.users.filter((u) => u.isGM).map((u) => u.id), data.userId])];
  const trace = (html) => game.settings.get(ID, "chatLog")
    ? ChatMessage.create({ content: `<div class="dh-chat">${html}</div>`, whisper: whisper() })
    : null;

  if (data.type === "fileRequest" && (!offer || !user || !offer.users.includes(user.id))) {
    return reply({ ok: false, reason: "expired" });
  }
  if (!offer || !user || !offer.users.includes(user.id)) return;
  const who = esc(user.character?.name ?? user.name);

  if (data.type === "fileSkip") {
    if (!offer.filed.has(user.id)) await trace(`<i class="fa-solid fa-envelope"></i> ${who} n'a pas rangé <b>${esc(offer.title)}</b>.`);
    return;
  }

  if (offer.filed.has(user.id)) return reply({ ok: true, pageUuid: offer.filed.get(user.id) });
  try {
    const pageUuid = await fileForUser(user, offer.pages, offer.era, offer.note);
    if (!pageUuid) return reply({ ok: false, reason: "nobook" });
    offer.filed.set(user.id, pageUuid);
    reply({ ok: true, pageUuid });
    await trace(`<i class="fa-solid fa-envelope-open-text"></i> ${who} a rangé <b>${esc(offer.title)}</b> dans son ${bookWord}.`);
  } catch (err) {
    console.error(`${ID} | rangement à la demande de ${user.name}`, err);
    reply({ ok: false, reason: "error" });
  }
}

/* ================================================================== */
/*  Apparition chez le joueur                                          */
/* ================================================================== */

const Reveal = {
  async show(data) {
    document.getElementById("dh-reveal")?.remove();
    const pageUuid = data.pages?.[game.user.id] ?? null;

    // Contenu à montrer
    let body = "";
    let imgSrc = null;
    const imgHtml = (src) => { imgSrc = src; return `<div class="dh-doc-imgwrap"><img class="dh-doc-img" src="${esc(src)}" alt=""></div>`; };
    const bookWord = (data.fileEra ?? data.era) === "modern" ? "carnet" : "journal";
    if (data.kind === "image") {
      body = imgHtml(data.src);
    } else if (data.choice) {
      // Rien n'est encore rangé : on montre le contenu envoyé par le Gardien
      if (data.display?.type === "image") body = imgHtml(data.display.src);
      else if (data.display?.type === "text") {
        const html = await TextEditorImpl().enrichHTML(data.display.html, { secrets: false });
        body = `<div class="dh-doc-text">${html}</div>`;
      } else body = `<p class="dh-doc-empty">Ce document n'a pas d'aperçu.</p>`;
    } else {
      const page = (pageUuid ? await fromUuid(pageUuid) : null) ?? (data.sourceUuid ? await fromUuid(data.sourceUuid) : null);
      const first = page?.documentName === "JournalEntry" ? page.pages.contents[0] : page;
      if (first?.type === "image") body = imgHtml(first.src);
      else if (first?.text?.content) {
        const html = await TextEditorImpl().enrichHTML(first.text.content, { relativeTo: first, secrets: false });
        body = `<div class="dh-doc-text">${html}</div>`;
      } else body = `<p class="dh-doc-empty">Le document a été rangé dans votre ${data.era === "modern" ? "carnet" : "journal"} de bord.</p>`;
    }

    const el = document.createElement("div");
    el.id = "dh-reveal";
    el.className = `dh-reveal dh-era-${data.era === "modern" ? "modern" : "1933"}`;
    const foot = data.choice
      ? `<footer class="dh-doc-foot dh-choice">
            <button type="button" data-dh="file"><i class="fa-solid fa-book-bookmark"></i> Ranger dans mon ${bookWord} de bord</button>
            <button type="button" data-dh="skip"><i class="fa-solid fa-xmark"></i> Ne pas ranger</button>
          </footer>`
      : `<footer class="dh-doc-foot">
            ${pageUuid ? `<button type="button" data-dh="open"><i class="fa-solid fa-book-open"></i> Ouvrir dans mon ${data.era === "modern" ? "carnet" : "journal"} de bord</button>` : ""}
            <button type="button" data-dh="close"><i class="fa-solid fa-check"></i> ${pageUuid ? "Ranger" : "Fermer"}</button>
          </footer>`;
    const sender = parseSender(data.sender);
    if (data.era === "modern") {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const file = attachmentName(data);
      el.innerHTML = `
      <div class="dh-veil"></div>
      <div class="dh-stage">
        <div class="dh-mail-toast">
          <div class="dh-mail-appicon"><i class="fa-solid fa-envelope"></i></div>
          <div class="dh-mail-toast-txt">
            <div class="dh-mail-toast-top"><b>Nouveau message</b><span>maintenant</span></div>
            <div class="dh-mail-toast-from">${esc(sender.name)}</div>
            <div class="dh-mail-toast-subj">${esc(data.title)}</div>
            <div class="dh-mail-toast-att"><i class="fa-solid fa-paperclip"></i> 1 pièce jointe</div>
          </div>
        </div>
        <div class="dh-doc dh-mail">
          <div class="dh-mail-bar">
            <span class="dh-mail-dots"><i></i><i></i><i></i></span>
            <span class="dh-mail-box"><i class="fa-solid fa-inbox"></i> Boîte de réception</span>
            <span class="dh-mail-tools"><i class="fa-solid fa-reply"></i><i class="fa-solid fa-share"></i><i class="fa-regular fa-trash-can"></i></span>
          </div>
          <header class="dh-doc-head dh-mail-head">
            <span class="dh-doc-title">${esc(data.title)}</span>
            <div class="dh-mail-meta">
              <div class="dh-mail-avatar">${esc(sender.initial)}</div>
              <div class="dh-mail-who">
                <div><b>${esc(sender.name)}</b> ${sender.addr ? `<span>&lt;${esc(sender.addr)}&gt;</span>` : ""}</div>
                <div class="dh-mail-to">À : moi · Aujourd'hui, ${hhmm}</div>
              </div>
            </div>
          </header>
          ${data.note ? `<div class="dh-mail-msg">${esc(data.note)}</div>` : ""}
          <div class="dh-mail-att">
            <i class="fa-solid ${/\.(png|jpe?g|webp|gif|avif|svg)$/i.test(file) ? "fa-file-image" : "fa-file-pdf"}"></i>
            <span class="dh-mail-att-name">${esc(file)}</span>
            <span class="dh-mail-att-state"><span class="dh-mail-dl">Téléchargement…</span><span class="dh-mail-ok"><i class="fa-solid fa-check"></i> Ouvert</span></span>
            <div class="dh-mail-progress"><i></i></div>
          </div>
          <div class="dh-doc-body">${body}</div>
          ${foot}
        </div>
      </div>`;
    } else {
      el.innerHTML = `
      <div class="dh-veil"></div>
      <div class="dh-stage">
        <div class="dh-envelope">
          <div class="dh-env-back"></div>
          <div class="dh-env-flap"></div>
          <div class="dh-env-front"><span class="dh-env-label">Pli confidentiel${data.sender ? `<span class="dh-env-from">De la part de ${esc(sender.name)}</span>` : ""}</span></div>
          <div class="dh-seal"></div>
        </div>
        <div class="dh-doc">
          <header class="dh-doc-head">
            <span class="dh-doc-kicker">Pièce remise</span>
            <span class="dh-doc-title">${esc(data.title)}</span>
            ${data.note ? `<span class="dh-doc-note">${esc(data.note)}</span>` : ""}
          </header>
          <div class="dh-doc-body">${body}</div>
          ${foot}
        </div>
      </div>`;
    }
    if (data.choice) { el.dataset.offer = data.offerId ?? ""; el.dataset.book = bookWord; }
    el.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-dh]");
      const act = b?.dataset.dh;
      // Quand le joueur doit choisir, un clic à côté ne ferme pas (il perdrait l'aide sans le vouloir)
      if (ev.target.classList.contains("dh-veil") && !data.choice) return this.close(el);
      if (act === "close") return this.close(el);
      if (act === "open") {
        const uuid = el.dataset.page || pageUuid;
        if (!uuid) return;
        this.close(el);
        const page = await fromUuid(uuid);
        page?.parent?.sheet?.render(true, { pageId: page.id });
      }
      if (act === "skip") {
        if (!data.preview) game.socket.emit(SOCKET, { type: "fileSkip", userId: game.user.id, offerId: data.offerId });
        return this.close(el);
      }
      if (act === "file") {
        if (data.preview) {
          ui.notifications.info("Aperçu : rien n'est rangé.");
          return this.close(el);
        }
        this.pending(el, true);
        game.socket.emit(SOCKET, { type: "fileRequest", userId: game.user.id, offerId: data.offerId });
        // Le Gardien doit répondre ; sinon on rend la main au joueur
        el._dhTimer = setTimeout(() => {
          this.pending(el, false);
          ui.notifications.warn("Le Gardien n'a pas répondu : réessayez dans un instant.");
        }, 8000);
      }
    });
    document.body.append(el);
    if (imgSrc && zoomEnabled()) {
      const wrap = el.querySelector(".dh-doc-imgwrap");
      attachZoom(wrap, wrap.querySelector("img"), {
        src: imgSrc, title: data.title, ping: false, broadcast: false,
        openFull: () => { this.close(el); openImage(imgSrc, data.title); }
      });
    }
    requestAnimationFrame(() => el.classList.add("dh-play"));

    const sound = game.settings.get(ID, "sound");
    if (sound) foundry.audio.AudioHelper.play({ src: sound, volume: 0.6, autoplay: true, loop: false }, false);
  },

  close(el) {
    clearTimeout(el._dhTimer);
    el.classList.add("dh-leaving");
    setTimeout(() => el.remove(), 350);
  },

  /** Boutons grisés pendant que le Gardien range la copie */
  pending(el, on) {
    clearTimeout(on ? undefined : el._dhTimer);
    el.querySelectorAll(".dh-choice button").forEach((b) => { b.disabled = on; });
    el.querySelector(".dh-choice")?.classList.toggle("dh-wait", on);
  },

  /** Réponse du Gardien à « Ranger » */
  filed(data) {
    const el = document.getElementById("dh-reveal");
    if (!el || el.dataset.offer !== (data.offerId ?? "")) return;
    clearTimeout(el._dhTimer);
    this.pending(el, false);
    const foot = el.querySelector(".dh-doc-foot");
    if (!foot) return;
    if (data.ok) {
      el.dataset.page = data.pageUuid ?? "";
      foot.classList.remove("dh-choice");
      foot.innerHTML = `${data.pageUuid ? `<button type="button" data-dh="open"><i class="fa-solid fa-book-open"></i> Ouvrir dans mon ${el.dataset.book || "journal"} de bord</button>` : ""}
        <button type="button" data-dh="close"><i class="fa-solid fa-check"></i> Rangé — fermer</button>`;
    } else {
      const why = data.reason === "expired" ? "Cette remise n'est plus disponible : demandez au Gardien de vous la remettre de nouveau."
        : data.reason === "nobook" ? "Vous n'avez pas de journal de bord : prévenez le Gardien."
        : "Le rangement a échoué : prévenez le Gardien.";
      ui.notifications.warn(why);
    }
  }
};

/* ================================================================== */
/*  Fenêtre du Gardien                                                 */
/* ================================================================== */

/** « Nom <adresse> », « adresse » ou « Nom » → { name, addr, initial } */
function parseSender(raw) {
  const t = String(raw ?? "").trim();
  let name = t, addr = "";
  const m = t.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) { name = m[1].trim() || m[2].trim(); addr = m[2].trim(); }
  else if (/^\S+@\S+$/.test(t)) { addr = t; name = t.split("@")[0]; }
  if (!name) name = "Expéditeur inconnu";
  return { name, addr, initial: (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase() };
}

/** Nom de la « pièce jointe » affiché dans le mail. */
function attachmentName(data) {
  const src = data.imgName || (data.kind === "image" ? data.src : null);
  if (src) {
    try { return decodeURIComponent(src.split("?")[0].split("/").pop()); } catch { return src.split("/").pop(); }
  }
  const base = String(data.title || "document").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${base || "document"}.pdf`;
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class DistributeApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: "distribution-aides-app",
    tag: "form",
    classes: ["dh-app"],
    window: { title: "Remettre une aide de jeu", icon: "fa-solid fa-envelope-open-text", resizable: true },
    position: { width: 480, height: "auto" },
    form: { handler: DistributeApp.#onSubmit, closeOnSubmit: false },
    actions: {
      pickImage: DistributeApp.#pickImage,
      clearDoc: DistributeApp.#clearDoc,
      all: DistributeApp.#all,
      none: DistributeApp.#none
    }
  };

  static PARTS = { main: { template: `modules/${ID}/templates/distribute.hbs` } };

  handout = null;

  static async open(doc) {
    if (!game.user.isGM) return;
    if (!this.instance) this.instance = new DistributeApp();
    if (doc) await this.instance.setDocument(doc);
    this.instance.render({ force: true });
  }

  /** Ouvre la fenêtre de remise avec une image déjà choisie (bouton de la fenêtre d'image). */
  static async openImage(src, title) {
    if (!game.user.isGM || !src) return;
    if (!this.instance) this.instance = new DistributeApp();
    const name = String(title || "").trim()
      || decodeURIComponent(src.split("/").pop().replace(/\.[^.]+$/, "")).replace(/[_-]+/g, " ");
    this.instance.handout = { kind: "image", src, title: name, preview: src, type: "image" };
    this.instance.render({ force: true });
  }

  async setDocument(doc) {
    if (typeof doc === "string") doc = await fromUuid(doc);
    if (!doc) return;
    if (doc.documentName === "JournalEntryPage") {
      this.handout = { kind: "page", uuid: doc.uuid, title: doc.name, preview: doc.type === "image" ? doc.src : null, type: doc.type, parentName: doc.parent?.name };
    } else if (doc.documentName === "JournalEntry") {
      const first = doc.pages.contents[0];
      this.handout = { kind: "entry", uuid: doc.uuid, title: doc.name, preview: first?.type === "image" ? first.src : null, type: "entry", count: doc.pages.size };
    } else if (doc.documentName === "Tile" || doc.documentName === "Actor" || doc.documentName === "Item") {
      const src = doc.texture?.src ?? doc.img;
      this.handout = { kind: "image", src, title: doc.name ?? "Image", preview: src, type: "image" };
    }
  }

  async _prepareContext() {
    const players = game.users.filter((u) => !u.isGM).map((u) => ({
      id: u.id,
      name: u.name,
      character: u.character?.name ?? "",
      active: u.active,
      book: !!logbookFor(u, "1933"),
      bookModern: !!logbookFor(u, "modern"),
      color: u.color?.css ?? u.color
    })).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "fr"));
    return {
      h: this.handout,
      players,
      folder: logbookFolder("1933")?.name ?? null,
      folderModern: logbookFolder("modern")?.name ?? null,
      era: this.handout ? eraOf(this.handout) : era(),
      canCreate: game.settings.get(ID, "createLogbook")
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const form = this.element.querySelector(".dh-form");
    const sel = this.element.querySelector('select[name="era"]');
    if (form && sel) {
      const sync = () => { form.dataset.era = sel.value; };
      sel.addEventListener("change", sync);
      sync();
    }
    // « Laisser le joueur choisir » n'a de sens que si on range et qu'on fait apparaître le document
    const file = this.element.querySelector('input[name="file"]');
    const reveal = this.element.querySelector('input[name="reveal"]');
    const choice = this.element.querySelector('input[name="choice"]');
    if (file && reveal && choice) {
      const syncChoice = () => {
        const ok = file.checked && reveal.checked;
        choice.disabled = !ok;
        if (!ok) choice.checked = false;
      };
      file.addEventListener("change", syncChoice);
      reveal.addEventListener("change", syncChoice);
      syncChoice();
    }
    const zone = this.element.querySelector(".dh-drop");
    if (!zone) return;
    zone.addEventListener("dragover", (ev) => { ev.preventDefault(); zone.classList.add("dh-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dh-over"));
    zone.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      zone.classList.remove("dh-over");
      try {
        const data = TextEditorImpl().getDragEventData(ev);
        if (data?.uuid) await this.setDocument(data.uuid);
        else if (data?.type === "Tile" && data.texture?.src) this.handout = { kind: "image", src: data.texture.src, title: "Image", preview: data.texture.src, type: "image" };
        this.render();
      } catch (err) {
        console.error(`${ID} | dépôt`, err);
        ui.notifications.error("Ce document ne peut pas être remis.");
      }
    });
  }

  static #pickImage() {
    const FP = foundry.applications.apps.FilePicker.implementation;
    new FP({
      type: "image",
      callback: (path) => {
        const name = decodeURIComponent(path.split("/").pop().replace(/\.[^.]+$/, "")).replace(/[_-]+/g, " ");
        this.handout = { kind: "image", src: path, title: name, preview: path, type: "image" };
        this.render();
      }
    }).render(true);
  }

  static #clearDoc() { this.handout = null; this.render(); }
  static #all() { this.element.querySelectorAll('input[name="users"]').forEach((c) => { c.checked = true; }); }
  static #none() { this.element.querySelectorAll('input[name="users"]').forEach((c) => { c.checked = false; }); }

  static async #onSubmit(event, form, formData) {
    if (!this.handout) return ui.notifications.warn("Déposez d'abord un document ou choisissez une image.");
    const fd = form.elements;
    const users = [...form.querySelectorAll('input[name="users"]:checked')].map((c) => c.value);
    const handout = { ...this.handout, title: fd.title.value.trim() || this.handout.title };
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      await distribute(handout, {
        users,
        note: fd.note.value.trim(),
        sender: fd.sender?.value.trim() ?? "",
        file: fd.file.checked,
        choice: fd.choice?.checked ?? false,
        reveal: fd.reveal.checked,
        grant: fd.grant?.checked ?? false,
        era: fd.era?.value ?? "",
        preview: fd.preview.checked
      });
    } finally {
      if (btn) btn.disabled = false;
    }
  }
}

/* ================================================================== */
/*  Points d'entrée : barre de gauche, clic droit, en-tête de journal  */
/* ================================================================== */

Hooks.on("getSceneControlButtons", (controls) => {
  const tokens = controls.tokens;
  if (!tokens?.tools) return;
  tokens.tools.distributionAides = {
    name: "distributionAides",
    title: "Remettre une aide de jeu",
    icon: "fa-solid fa-envelope-open-text",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: game.user.isGM,
    onChange: () => DistributeApp.open()
  };
});

const isV14 = () => (game.release?.generation ?? 13) >= 14;
function pickTarget(args) {
  for (const a of args) {
    if (a instanceof HTMLElement) return a;
    if (a?.[0] instanceof HTMLElement) return a[0];
  }
  return args.find((a) => a?.currentTarget instanceof HTMLElement)?.currentTarget ?? null;
}
function entryFrom(target) {
  const li = target?.closest?.("[data-entry-id], [data-document-id]") ?? target;
  const id = li?.dataset?.entryId ?? li?.dataset?.documentId;
  return id ? game.journal.get(id) : null;
}

Hooks.on("getJournalEntryContextOptions", (app, items) => {
  if (!game.user.isGM) return;
  const run = (...args) => { const e = entryFrom(pickTarget(args)); if (e) DistributeApp.open(e); };
  const label = "Remettre aux joueurs…";
  items.push(isV14()
    ? { label, icon: "fa-solid fa-envelope-open-text", onClick: run }
    : { name: label, icon: '<i class="fa-solid fa-envelope-open-text"></i>', callback: run });
});

// Bouton dans le menu de la fenêtre d'un journal : remet la page affichée
Hooks.on("getHeaderControlsJournalEntrySheet", (app, controls) => {
  if (!game.user.isGM) return;
  app.options.actions ??= {};
  app.options.actions.dhDistribute = function () {
    const pageId = this.pageId ?? this._pages?.[this.pageIndex]?._id;
    const page = pageId ? this.document.pages.get(pageId) : null;
    DistributeApp.open(page ?? this.document);
  };
  controls.push({ icon: "fa-solid fa-envelope-open-text", label: "Remettre aux joueurs…", action: "dhDistribute" });
});
