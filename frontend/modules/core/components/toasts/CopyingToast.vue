<template>
  <Toast loading>
    <template #title>{{ $t('copyingToast.title') }}</template>
    <span>{{ $t('copyingToast.content') }}</span>
  </Toast>
</template>

<script>
import Toast from '@supertask/modules/core/components/toasts/Toast'
export default {
  name: 'CopyingToast',
  components: {
    Toast,
  },
}
</script>
