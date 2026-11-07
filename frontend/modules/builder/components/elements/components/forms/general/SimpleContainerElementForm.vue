<template>
  <form @submit.prevent @keydown.enter.prevent>
    <p>{{ $t('simpleContainerElementForm.noConfigurationOptions') }}</p>
  </form>
</template>

<script>
import elementForm from '@supertask/modules/builder/mixins/elementForm'

export default {
  name: 'SimpleContainerElementForm',
  mixins: [elementForm],
  data() {
    return {
      values: {
        styles: {},
      },
      allowedValues: ['styles'],
    }
  },
}
</script>
