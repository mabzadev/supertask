<template>
  <div>
    <slot></slot>
    <a
      class="made-with-supertask"
      title="Supertask"
      :href="showPaidFeaturesModal ? null : $config.public.publicWebFrontendUrl"
      :target="showPaidFeaturesModal ? null : '_blank'"
      @click="handleMadeWithSupertaskClick"
    >
      Made with
      <img
        src="@supertask_enterprise/assets/images/builder/mini_logo.svg?url"
        alt="Supertask"
      />
    </a>

    <PaidFeaturesModal
      ref="paidFeaturesModal"
      :initial-selected-type="paidFeatureType"
    ></PaidFeaturesModal>
  </div>
</template>

<script>
import PaidFeaturesModal from '@supertask_premium/components/PaidFeaturesModal'
import { BuilderBrandingPaidFeature } from '@supertask_enterprise/paidFeatures'

export default {
  components: {
    PaidFeaturesModal,
  },
  props: {
    showPaidFeaturesModal: {
      type: Boolean,
      default: false,
    },
  },
  computed: {
    paidFeatureType() {
      return BuilderBrandingPaidFeature.getType()
    },
  },
  methods: {
    handleMadeWithSupertaskClick(event) {
      if (this.showPaidFeaturesModal) {
        event.preventDefault()
        this.$refs.paidFeaturesModal.show()
      }
    },
  },
}
</script>
