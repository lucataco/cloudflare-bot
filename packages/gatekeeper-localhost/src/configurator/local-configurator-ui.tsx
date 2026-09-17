import { Field, h, Section, TextInput, type ConfiguratorUISpec } from '@gadgets/configurator-ui';
import type { LocalConfiguratorRpc, LocalConfiguratorValues } from './local-configurator-types';

export default {
  initial: {},
  isReady({ values }) { return !!values.url?.trim(); },
  initialValuesFromResourceUrl({ resourceUrl }) { return { url: resourceUrl }; },
  resourceUrl({ values, ui }) { return ui.resourceUrl(values.url ?? ''); },
  render({ values, setValues }) {
    return <Section><Field label="Paired desktop resource" description="Paste a folder, execution or network URL printed by your desktop daemon. Pairing alone does not grant a bot access.">
      <TextInput name="url" value={values.url} placeholder="localhost://device-id/folders/documents" onChange={url => setValues({ url })} />
    </Field></Section>;
  },
} satisfies ConfiguratorUISpec<LocalConfiguratorRpc, LocalConfiguratorValues>;
