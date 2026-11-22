// Lebenslauf pro Stelle (routine/cv.py). Daten fertig sortiert als JSON über sys.inputs.data.
// Carlito wie im Brief, Überschriften in TeX Gyre Adventor, Foto oben rechts, A4, höchstens 2 Seiten.
#let d = json(bytes(sys.inputs.at("data")))
#let hd = d.h
#let accent = rgb("#7a6a2c")
#let muted = rgb("#5f5f5f")
#let rule = rgb("#d9d3bf")
#let head-font = "TeX Gyre Adventor"

#set document(title: hd.title + " " + d.name, author: d.name)
#set page(paper: "a4", margin: (top: 1.6cm, bottom: 1.5cm, left: 1.9cm, right: 1.9cm),
  footer: context {
    if counter(page).final().first() > 1 [
      #set text(size: 8pt, fill: muted)
      #d.name #h(1fr) #counter(page).display("1/1", both: true)
    ]
  })
#set text(font: "Carlito", size: 10.5pt, lang: d.lang, region: "CH", hyphenate: false, fill: rgb("#222222"))
#set par(leading: 0.5em, spacing: 0.6em, justify: false)

// Abschnitt: Überschrift, danach führt eine Linie auf halber Versalhöhe sie bis zum Rand weiter.
// keep: true = nie über den Seitenumbruch teilen.
#let section(title, body, keep: false) = block(above: 1.6em, below: 0pt, width: 100%, breakable: not keep, {
  block(above: 0pt, below: 0.8em, sticky: true, width: 100%, {
    text(font: head-font, size: 9.5pt, weight: "bold", fill: accent, tracking: 0.08em)[#upper(title)]
    h(0.6em)
    box(width: 1fr, move(dy: -3.3pt, line(length: 100%, stroke: 1pt + rule)))
  })
  body
})

// Zeitraum links, Inhalt rechts
#let datecol = 2.75cm
#let entry(period, body) = block(above: 1em, below: 0pt, breakable: false,
  grid(columns: (datecol, 1fr), column-gutter: 0.35cm,
    text(size: 9.5pt, fill: muted)[#period], body))

#let bullet(hl) = text(fill: accent, size: if hl { 9pt } else { 7pt })[#sym.bullet]
#let tasks(items) = {
  set par(leading: 0.42em)
  block(above: 0.4em, grid(columns: (0.4cm, 1fr), row-gutter: 0.38em,
    ..items.map(t => (align(center, bullet(t.hl)), t.text)).flatten()))
}

// Foto im Rahmen 3.3 x 4.1 cm; crop aus cv.yaml (zoom, x = Bildmitte als Anteil der Breite, y = Versatz von oben)
#let photo-box(path, crop) = context {
  let (w, hgt) = (3.3cm, 4.1cm)
  let img = image(path, width: w * crop.at("zoom", default: 1.0))
  let sz = measure(img)
  let dx = calc.max(w - sz.width, calc.min(0pt, w / 2 - sz.width * crop.at("x", default: 0.5)))
  let dy = calc.max(hgt - sz.height, calc.min(0pt, -sz.height * crop.at("y", default: 0.0)))
  box(width: w, height: hgt, clip: true, radius: 3pt, place(top + left, dx: dx, dy: dy, img))
}

// Kopf: Name, Kontakt, Personalien, Foto
#let c = d.contact
#grid(columns: (1fr, 3.3cm), column-gutter: 0.8cm,
  [
    #text(font: head-font, size: 9pt, fill: accent, tracking: 0.14em)[#upper(hd.title)]
    #v(0.1em)
    #text(font: head-font, size: 23pt, weight: "regular")[#d.name]
    #v(0.5em)
    #set text(size: 9.8pt)
    #let lines(items) = stack(spacing: 0.5em, ..items)
    #grid(columns: (auto, auto), column-gutter: 1cm,
      lines(([#c.street, #c.zip_city], [#c.phone], link("mailto:" + c.email)[#c.email])),
      lines(d.personal.map(p => text(fill: muted)[#p.label:] + [ #p.value])),
    )
  ],
  if d.photo != none {
    photo-box(d.photo, d.photo_crop)
  },
)

#if d.profile != none {
  section(hd.profile)[
    #set par(leading: 0.55em)
    #d.profile
  ]
}

#section(hd.education)[
  #for e in d.education {
    entry(e.period)[
      *#e.title* \
      #text(fill: muted)[#e.institution#if e.note != none [, #e.note]]
    ]
  }
]

#section(hd.experience)[
  #for e in d.experience {
    entry(e.period)[
      *#e.role* #h(0.25em) #text(fill: accent)[|] #h(0.25em) #e.company#if e.location != none [, #e.location]
      #if e.note != none [ \ #text(size: 9.5pt, fill: muted)[#e.note]]
      #tasks(e.tasks)
    ]
  }
]

// Kompetenzen: jede Gruppe als Ganzes, nie über den Seitenumbruch geteilt
#for g in d.skills {
  section(g.title, keep: true, grid(columns: (datecol + 1.6cm, 1fr), column-gutter: 0.35cm, row-gutter: 0.5em,
    ..g.items.map(it => (text(weight: "bold")[#it.label], it.text)).flatten()))
}

#block(above: 1.6em, breakable: false, grid(columns: (1fr, 1fr), column-gutter: 0.8cm,
  section(hd.languages, keep: true, grid(columns: (2.2cm, 1fr), row-gutter: 0.5em,
    ..d.languages.map(l => (text(weight: "bold")[#l.language], l.level)).flatten())),
  section(hd.hobbies, keep: true, grid(columns: (0.4cm, 1fr), row-gutter: 0.5em,
    ..d.hobbies.map(x => (align(center, bullet(false)), x)).flatten())),
))
