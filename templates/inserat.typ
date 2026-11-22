// Screenshot eines Stelleninserats, in A4-Streifen, mit Link und Abrufzeitpunkt in der Kopfzeile.
#let d = json(bytes(sys.inputs.at("data")))
#set page(paper: "a4", margin: (x: 1cm, top: 1.6cm, bottom: 1cm),
  header: text(size: 7.5pt, fill: gray)[Inserat abgerufen am #d.when: #d.url])
#set text(font: "Carlito", size: 9pt)
#for (i, p) in d.images.enumerate() [
  #if i > 0 { pagebreak() }
  #align(center, image(p, width: 100%, height: 100%, fit: "contain"))
]
