<template>
  <form :class="{ 'service-form--small': small }" @submit.prevent>
    <div>
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
      <div v-if="values.integration_id && values.table_id" class="row">
        <div class="col col-6">
          <FormGroup
            small-label
            :label="$t('localSupertaskGetRowForm.rowFieldLabel')"
            required
          >
            <InjectedFormulaInput
              v-model="values.row_id"
              :placeholder="$t('localSupertaskGetRowForm.rowFieldPlaceHolder')"
            />
            <template #helper>
              {{ $t('localSupertaskGetRowForm.rowFieldHelpText') }}
            </template>
          </FormGroup>
        </div>
      </div>
      <ServiceRefinementForms
        v-if="!fieldsLoading && values.table_id"
        class="margin-top-2"
        :small="small"
        :values="values"
        :table-fields="tableFields"
        show-filter
        show-search
      />
      <div v-if="fieldsLoading" class="loading-spinner"></div>
    </div>
  </form>
</template>

<script>
import form from '@supertask/modules/core/mixins/form'
import InjectedFormulaInput from '@supertask/modules/core/components/formula/InjectedFormulaInput'
import localSupertaskService from '@supertask/modules/integrations/localSupertask/mixins/localSupertaskService'
import LocalSupertaskServiceForm from '@supertask/modules/integrations/localSupertask/components/services/LocalSupertaskServiceForm'
import ServiceRefinementForms from '@supertask/modules/integrations/localSupertask/components/services/ServiceRefinementForms'

export default {
  components: {
    LocalSupertaskServiceForm,
    InjectedFormulaInput,
    ServiceRefinementForms,
  },
  mixins: [form, localSupertaskService],
  data() {
    return {
      allowedValues: [
        'table_id',
        'view_id',
        'row_id',
        'search_query',
        'filters',
        'filter_type',
      ],
      values: {
        table_id: null,
        view_id: null,
        row_id: {},
        search_query: {},
        filters: [],
        filter_type: 'AND',
      },
    }
  },
}
</script>
