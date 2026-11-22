// Nachweis der persönlichen Arbeitsbemühungen (Aufbau angelehnt an das SECO-Formular).
// Daten als JSON über sys.inputs.data (siehe routine/rav.py).
#let d = json(bytes(sys.inputs.at("data")))
#let me = d.person

#set document(title: "Arbeitsbemühungen " + d.month_label, author: me.name)
#set page(paper: "a4", flipped: true, margin: (x: 1.5cm, y: 1.4cm),
  footer: context [#set text(size: 8pt, fill: gray); #d.footer #h(1fr) Seite #counter(page).display() von #counter(page).final().first()])
#set text(font: "Carlito", size: 9.5pt, lang: "de", region: "CH")

#text(size: 15pt, weight: "bold")[Nachweis der persönlichen Arbeitsbemühungen]
#v(0.2em)
#grid(columns: (auto, 1fr, auto, 1fr), column-gutter: 0.8em, row-gutter: 0.45em,
  [*Name, Vorname:*], [#me.name],
  [*Monat:*], [#d.month_label],
  [*Adresse:*], [#me.street, #me.zip_city],
  [*Personennummer:*], [#d.at("personennummer", default: "")],
  [*Telefon / E-Mail:*], [#me.phone, #me.email],
  [*Anzahl Bewerbungen:*], [#d.entries.len()],
)
#v(0.6em)

#table(
  columns: (1.8em, 5.4em, 1fr, 0.9fr, 1fr, 4.4em, 6.4em, 10.2em),
  inset: 4pt,
  stroke: 0.5pt + gray,
  fill: (_, y) => if y == 0 { luma(235) },
  table.header(
    [*Nr.*], [*Datum*], [*Arbeitgeber (Name, Adresse)*], [*Kontaktperson (Name, Telefon, E-Mail)*],
    [*Stelle als*], [*Pensum*], [*Art der Bewerbung*], [*Ergebnis*],
  ),
  ..d.entries.enumerate().map(((i, e)) => (
    [#(i + 1)], [#e.date_label], [#e.employer], [#e.contact], [#e.role #if e.job_url != "" [ \ #text(size: 7pt, fill: rgb("#1a4f8b"))[#link(e.job_url)[#e.job_url]]]], [#e.pensum], [#e.art], [#e.result_label],
  )).flatten(),
)

#v(1.2em)
#grid(columns: (1fr, 1fr), column-gutter: 3em,
  [Ort, Datum: #d.place_date],
  [Unterschrift: #box(width: 1fr, repeat[.])],
)
