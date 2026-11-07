<template>
  <form @submit.prevent>
    <FormGroup
      class="margin-bottom-2"
      :label="$t('coreIterationServiceForm.source')"
      required
      small-label
    >
      <InjectedFormulaInput
        v-model="values.source"
        allow-node-selection
        :placeholder="$t('coreIterationServiceForm.sourcePlaceholder')"
      />
    </FormGroup>
  </form>
</template>

<script>
import form from '@supertask/modules/core/mixins/form'
import InjectedFormulaInput from '@supertask/modules/core/components/formula/InjectedFormulaInput'
import { useVuelidate } from '@vuelidate/core'

export default {
  name: 'CoreIteratorService',
  components: { InjectedFormulaInput },
  mixins: [form],
  props: {},
  setup() {
    return { v$: useVuelidate() }
  },
  data() {
    return {
      allowedValues: ['source'],
      values: {
        source: {},
      },
    }
  },
  methods: {},
  validations() {
    return {
      values: {
        source: {},
      },
    }
  },
}
</script>
