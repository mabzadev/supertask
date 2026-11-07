<template>
  <form @submit.prevent @keydown.enter.prevent>
    <FormGroup
      small-label
      :label="$t('generalForm.labelTitle')"
      class="margin-bottom-2"
      horizontal
      required
    >
      <InjectedFormulaInput
        v-model="values.label"
        :placeholder="$t('buttonFieldForm.labelPlaceholder')"
      />
      <template #after-input>
        <CustomStyleButton
          v-model="values.styles"
          style-key="cell"
          :config-block-types="['table', 'button']"
          :theme="baseTheme"
          :on-styles-changed="onFieldStylesChanged"
          :extra-args="{ onlyCell: true, noAlignment: true }"
          variant="normal"
        />
      </template>
    </FormGroup>
    <Alert>
      {{ $t('buttonFieldForm.infoMessage') }}
    </Alert>
  </form>
</template>

<script>
import collectionFieldForm from '@supertask/modules/builder/mixins/collectionFieldForm'
import InjectedFormulaInput from '@supertask/modules/core/components/formula/InjectedFormulaInput'
import CustomStyleButton from '@supertask/modules/builder/components/elements/components/forms/style/CustomStyleButton'

export default {
  name: 'ButtonFieldForm',
  components: { InjectedFormulaInput, CustomStyleButton },
  mixins: [collectionFieldForm],
  data() {
    return {
      allowedValues: ['label', 'styles'],
      values: {
        label: {},
        styles: {},
      },
    }
  },
}
</script>
