<template>
  <form @submit.prevent @keydown.enter.prevent>
    <CustomStyleButton
      v-if="values.level"
      v-model="values.styles"
      style-key="typography"
      :config-block-types="['typography']"
      :theme="builder.theme"
      :extra-args="{ headingLevel: values.level }"
    />
    <FormGroup
      small-label
      required
      :label="$t('headingElementForm.levelTitle')"
      class="margin-bottom-2"
    >
      <Dropdown v-model="values.level" :show-search="false">
        <DropdownItem
          v-for="level in levels"
          :key="level.value"
          :name="level.name"
          :value="level.value"
        >
          {{ level.name }}
        </DropdownItem>
      </Dropdown>
    </FormGroup>
    <FormGroup
      small-label
      :label="$t('headingElementForm.textTitle')"
      class="margin-bottom-2"
      required
    >
      <InjectedFormulaInput
        v-model="values.value"
        :placeholder="$t('elementForms.textInputPlaceholder')"
      />
    </FormGroup>
  </form>
</template>

<script>
import InjectedFormulaInput from '@supertask/modules/core/components/formula/InjectedFormulaInput'
import elementForm from '@supertask/modules/builder/mixins/elementForm'
import CustomStyleButton from '@supertask/modules/builder/components/elements/components/forms/style/CustomStyleButton'

export default {
  name: 'HeaderElementForm',
  components: {
    InjectedFormulaInput,
    CustomStyleButton,
  },
  mixins: [elementForm],
  data() {
    return {
      values: {
        value: {},
        level: 1,
        styles: {},
      },
      levels: [...Array(6).keys()].map((level) => ({
        name: this.$t('headingElementForm.headingName', { level: level + 1 }),
        value: level + 1,
      })),
      allowedValues: ['value', 'level', 'styles'],
    }
  },
}
</script>
