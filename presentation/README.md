# Pitwall: the presentation

`Pitwall.pptx` tells the Pitwall story in 20 slides, structured as a race ("LAP 01 / 20" through to the chequered flag):
how the model works, how it failed, and how it evolved. It uses the same F1 broadcast theme as the web app.
Every slide has speaker notes. `Pitwall.pdf` is the same deck as a PDF.

| Laps | Story |
|---|---|
| 1-3 | Lights out, the question (box or stay out?), the data and the season split |
| 4 | Act I: v1 looked great (R² 0.91) and was a circuit lookup (0.02 without circuit and driver) |
| 5-9 | Act II: the structural model, separating fuel from wear at the pit stop, tyre curves, pit loss and Safety Cars, the decision engine |
| 10-11 | Results on 2025, and the 0.81 leak trap |
| 12-13 | What broke: the model and the app, as DNF boards |
| 14-17 | How it evolved, the product, What If, the broadcast cinematics |
| 18-20 | Lessons, what's next, chequered flag |

## Fonts

The deck uses Barlow Condensed (Bold, Bold Italic), Barlow (Regular, Italic) and JetBrains Mono (Regular, Bold), all under
the SIL Open Font License (`fonts/`). Install the six `.ttf` files before opening the `.pptx`, or PowerPoint and Keynote will
substitute other fonts. The PDF already embeds them.

## Rebuild

```bash
pip install python-pptx pillow
python presentation/build_deck.py          # writes presentation/Pitwall.pptx
soffice --headless --convert-to pdf --outdir presentation presentation/Pitwall.pptx
```

`assets/` holds the app screenshots (captured from the live app) and the generated backgrounds. All numbers come from
`reports/metrics.json` and the project notes.
