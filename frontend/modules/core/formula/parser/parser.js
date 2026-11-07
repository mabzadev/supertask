import antlr4 from 'antlr4'
import SupertaskFormulaLexer from '@supertask/modules/core/formula/parser/generated/SupertaskFormulaLexer'
import SupertaskFormula from '@supertask/modules/core/formula/parser/generated/SupertaskFormula'
import { SupertaskFormulaParserError } from '@supertask/modules/core/formula/parser/errors'

/**
 * Attempts to parse an input string into a Supertask Formula. If it fails a
 * SupertaskFormulaParserError will be raised.
 *
 * @param formula
 * @return {*} The resulting antlr4 parse tree of the formula
 */
export default function parseSupertaskFormula(formula) {
  const chars = new antlr4.InputStream(formula)
  const lexer = new SupertaskFormulaLexer(chars)
  const tokens = new antlr4.CommonTokenStream(lexer)
  const parser = new SupertaskFormula(tokens)
  parser.removeErrorListeners()
  // noinspection JSUnusedLocalSymbols
  parser.addErrorListener({
    syntaxError: (recognizer, offendingSymbol, line, column, msg, err) => {
      throw new SupertaskFormulaParserError(offendingSymbol, line, column, msg)
    },
  })
  parser.buildParseTrees = true
  return parser.root()
}

export function getTokenStreamForFormula(formula) {
  const chars = new antlr4.InputStream(formula)
  const lexer = new SupertaskFormulaLexer(chars)
  const stream = new antlr4.CommonTokenStream(lexer)
  stream.lazyInit()
  stream.fill()
  return stream
}
