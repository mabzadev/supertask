import { TestApp } from '@supertask/test/helpers/testApp'
import { RuntimeFunctionCollection } from '@supertask/modules/core/functionCollection'
import { ToTipTapVisitor } from '@supertask/modules/core/formula/tiptap/toTipTapVisitor'
import parseSupertaskFormula from '@supertask/modules/core/formula/parser/parser'
import testCases from '@supertask_test_cases/tip_tap_visitor_cases.json'

describe('toTipTapVisitor', () => {
  let testApp = null
  beforeEach(() => {
    testApp = new TestApp()
  })

  testCases.forEach(({ formula, content }) => {
    it(`should return the expected formula for ${formula}`, () => {
      const functionCollection = new RuntimeFunctionCollection(
        testApp.store.$registry
      )
      // We don't want to test empty formula
      if (formula) {
        const tree = parseSupertaskFormula(formula)
        const result = new ToTipTapVisitor(functionCollection).visit(tree)
        expect(result).toEqual(content)
      }
    })
  })
})
