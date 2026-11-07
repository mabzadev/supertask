import parseSupertaskFormula from '@supertask/modules/core/formula/parser/parser'
import { SupertaskFormulaParserError } from '@supertask/modules/core/formula/parser/errors'

describe('Supertask Formula Tests', () => {
  const validFormulas = ["lower('test')", "upper('test')"]
  const invalidFormulas = [
    ['a', SupertaskFormulaParserError],
    ['12ssda3', SupertaskFormulaParserError],
  ]

  test.each(validFormulas)(
    'valid supertask formulas do not raise a parser error',
    (value) => {
      expect(parseSupertaskFormula(value)).toBeTruthy()
    }
  )

  test.each(invalidFormulas)(
    'invalid supertask formulas raise a parser error',
    (value, exception) => {
      expect(() => parseSupertaskFormula(value)).toThrow(exception)
    }
  )
})
