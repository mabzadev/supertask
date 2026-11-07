<template>
  <Toast loading type="info-primary">
    <template #title>{{ $t('PastingToast.title') }}</template>
    <span>{{ $t('PastingToast.content') }}</span>
  </Toast>
</template>

<script>
import Toast from '@supertask/modules/core/components/toasts/Toast'
export default {
  name: 'PastingToast',
  components: {
    Toast,
  },
}
</script>
