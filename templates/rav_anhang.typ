// Trennblatt im Anhang der RAV-Liste: zu welcher Bewerbung der folgende Inserat-Screenshot gehört.
#let d = json(bytes(sys.inputs.at("data")))
#set page(paper: "a4", margin: 2cm)
#set text(font: "Carlito", size: 12pt, lang: "de")
#v(30%)
#align(center)[
  #text(size: 11pt, fill: gray)[Anhang zur Liste der Arbeitsbemühungen]
  #v(0.6em)
  #text(size: 20pt, weight: "bold")[Nr. #d.nr: #d.company]
  #v(0.3em)
  #text(size: 14pt)[#d.role]
  #v(0.3em)
  Bewerbung vom #d.date
  #v(1em)
  #if d.url != "" [Link zum Inserat: #link(d.url)[#text(fill: rgb("#1a4f8b"))[#d.url]]] else [Kein Link erfasst]
  #v(0.6em)
  #if d.has_ad [Auf den folgenden Seiten: Screenshot des Inserats zum Zeitpunkt der Bewerbung.] else [#text(fill: gray)[Kein Screenshot vorhanden.]]
]
