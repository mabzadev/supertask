<template>
  <form :class="{ 'service-form--small': small }" @submit.prevent>
    <div class="row">
      <div class="col col-12">
        <LocalSupertaskServiceForm
          :application="application"
          :service-type="serviceType"
          :default-values="defaultValues"
          :enable-integration-picker="enableIntegrationPicker"
          @values-changed="values = { ...values, ...$event }"
        ></LocalSupertaskServiceForm>
      </div>
    </div>

    <ServiceRefinementForms
      v-if="!fieldsLoading && values.table_id"
      :small="small"
      :values="values"
      :table-fields="tableFields"
      show-filter
      show-sort
      show-search
    >
      <template #additional-buttons>
        <FormGroup
          class="margin-top-1"
          small-label
          :label="$t('localSupertaskListRowsForm.defaultResultCount')"
          :helper-text="$t('localSupertaskListRowsForm.defaultResultCountHelp')"
          required
          :error-message="getFirstErrorMessage('default_result_count')"
        >
          <FormInput
            v-model="v$.values.default_result_count.$model"
            class="service-form__result-count-input"
            :placeholder="
              $t('localSupertaskListRowsForm.defaultResultCountPlaceholder')
            "
            :to-value="(value) => parseFloat(value)"
            type="number"
          />
        </FormGroup>
      </template>
      <template #additional-tabs>
        <Tab
          :title="$t('localSupertaskListRowsForm.advancedConfig')"
          class="service-form__search-form-tab"
        >
          <FormGroup
            class="margin-bottom-2"
            small-label
            :label="$t('localSupertaskListRowsForm.defaultResultCount')"
            :helper-text="$t('localSupertaskListRowsForm.defaultResultCountHelp')"
            required
            :error-message="getFirstErrorMessage('default_result_count')"
          >
            <FormInput
              v-model="v$.values.default_result_count.$model"
              class="service-form__result-count-input"
              :placeholder="
                $t('localSupertaskListRowsForm.defaultResultCountPlaceholder')
              "
              :to-value="(value) => parseFloat(value)"
              type="number"
            />
          </FormGroup>
        </Tab>
      </template>
    </ServiceRefinementForms>
    <div v-if="fieldsLoading" class="loading-spinner"></div>
  </form>
</template>

<script>
import form from '@supertask/modules/core/mixins/form'
import localSupertaskService from '@supertask/modules/integrations/localSupertask/mixins/localSupertaskService'
import ServiceRefinementForms from '@supertask/modules/integrations/localSupertask/components/services/ServiceRefinementForms'
import Tab from '@supertask/modules/core/components/Tab'
import {
  required,
  minValue,
  maxValue,
  helpers,
  integer,
} from '@vuelidate/validators'
import { useVuelidate } from '@vuelidate/core'
import LocalSupertaskServiceForm from '@supertask/modules/integrations/localSupertask/components/services/LocalSupertaskServiceForm'

export default {
  components: {
    LocalSupertaskServiceForm,
    ServiceRefinementForms,
    Tab,
  },
  mixins: [form, localSupertaskService],
  setup() {
    return { v$: useVuelidate({ $lazy: true }) }
  },
  data() {
    return {
      allowedValues: [
        'table_id',
        'view_id',
        'search_query',
        'filters',
        'filter_type',
        'sortings',
        'default_result_count',
      ],
      values: {
        table_id: null,
        view_id: null,
        search_query: {},
        filters: [],
        sortings: [],
        filter_type: 'AND',
        default_result_count: null,
      },
    }
  },
  computed: {
    maxResultLimit() {
      return this.service
        ? this.$registry
            .get('service', this.service.type)
            .getMaxResultLimit(this.service)
        : null
    },
  },

  validations() {
    return {
      values: {
        default_result_count: {
          required: helpers.withMessage(
            this.$t('error.requiredField'),
            required
          ),
          integer: helpers.withMessage(this.$t('error.integerField'), integer),
          minValue: helpers.withMessage(
            this.$t('error.minValueField', { min: 0 }),
            minValue(0)
          ),
          maxValue: helpers.withMessage(
            this.$t('error.maxValueField', { max: this.maxResultLimit }),
            maxValue(this.maxResultLimit)
          ),
        },
      },
    }
  },
}
</script>
