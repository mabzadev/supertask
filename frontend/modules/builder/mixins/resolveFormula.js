import RuntimeFormulaContext from '@supertask/modules/core/runtimeFormulaContext'
import { resolveFormula } from '@supertask/modules/core/formula'
import applicationContextMixin from '@supertask/modules/builder/mixins/applicationContext'

export default {
  mixins: [applicationContextMixin],
  computed: {
    runtimeFormulaContext() {
      /**
       * This proxy allow the RuntimeFormulaContextClass to act like a regular object.
       */
      return new Proxy(
        new RuntimeFormulaContext(
          this.$registry.getAll('builderDataProvider'),
          this.applicationContext
        ),
        {
          get(target, prop) {
            return target.get(prop)
          },
        }
      )
    },
    formulaFunctions() {
      return {
        get: (name) => {
          return this.$registry.get('runtimeFormulaFunction', name)
        },
      }
    },
  },
  methods: {
    resolveFormula(formula, formulaContext = null, defaultIfError = '') {
      try {
        return resolveFormula(
          formula,
          this.formulaFunctions,
          formulaContext || this.runtimeFormulaContext
        )
      } catch (e) {
        return defaultIfError
      }
    },
  },
}
