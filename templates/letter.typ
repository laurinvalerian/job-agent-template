// Anschreiben im Layout der Word-Vorlage (Calibri 11pt, Ränder 1.94/2.5 cm). Absender aus person.yaml.
// Daten kommen als JSON über sys.inputs.data (siehe routine/render.py).
#let d = json(bytes(sys.inputs.at("data")))
#let r = d.recipient
#let me = d.sender

#set document(title: d.subject, author: me.name)
#set page(paper: "a4", margin: (top: 1.94cm, bottom: 1.94cm, left: 2.5cm, right: 2.5cm))
#let lt = d.at("letter", default: (:))
#let style = lt.at("style", default: "block")
#set text(font: lt.at("font", default: "Carlito"), size: d.at("font_size", default: 11) * 1pt, lang: d.at("lang", default: "de"), region: "CH", hyphenate: false)
// Abstände wie im Musterbrief (Word, Calibri 11): Zeilenabstand 16.1 pt, Absatzabstand 24 pt, Adressblöcke 13.4 pt.
// spacing_scale (vom Build automatisch gewählt) staucht Fliesstext leicht, falls er sonst nicht auf eine Seite passt.
#let sp = d.at("spacing_scale", default: 1.0)
#set par(leading: 0.82em * sp, spacing: 1.54em * sp, justify: false)
#let addr(body) = block(spacing: 0.9em)[#set par(leading: 0.575em); #body]

#if style == "header_line" [
  // Absender in einer Zeile mit Linie darunter (Vorlage von Person B)
  #align(center)[#text(size: 0.85em)[#me.name #h(0.4em)|#h(0.4em) #me.street, #me.zip_city #h(0.4em)|#h(0.4em) #me.phone #h(0.4em)|#h(0.4em) #me.email]]
  #v(-0.3em)
  #line(length: 100%, stroke: 0.6pt)
] else [
  #addr[
    *#me.name* \
    #me.street \
    #me.zip_city \
    #me.phone \
    #me.email
  ]
]

#v(1.6em)
#addr[
  #r.company
  #if r.at("person", default: none) != none [ \ #r.person ]
  #if r.at("department", default: none) != none [ \ #r.department ]
  #if r.at("street", default: none) != none [ \ #r.street ]
  #if r.at("zip_city", default: none) != none [ \ #r.zip_city ]
]

#v(0.3em)
#align(right)[#d.place_date]
#v(0.6em)

#text(weight: "bold")[#d.subject]

#d.salutation

#for p in d.paragraphs [
  #p

]

#d.closing

#v(d.at("signature_gap", default: 0.2) * 1em)
#me.name
#if lt.at("signature", default: none) != none [
  #v(-0.2em)
  #image(lt.signature, height: lt.at("signature_height", default: 1.6) * 1cm)
]

#v(0.4em)
#text(size: 9pt)[#d.enclosures_label: #d.enclosures]
