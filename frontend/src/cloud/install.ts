/**
 * Wires the cloud feature into the OSS extension hooks. Importing this module
 * (once, from App.tsx) is the whole installation:
 *
 *  - proSession: resolve the stored token into a user on app mount.
 *  - proSaveAction: the editor's Save button opens the cloud projects modal
 *    when signed in, the sign-in modal when anonymous (the .vlx download
 *    stays available inside the projects modal).
 */

import { registerSessionCheck } from '../lib/proSession';
import { installSaveActionImpl } from '../lib/proSaveAction';
import { useCloudStore } from './useCloudStore';

registerSessionCheck(() => useCloudStore.getState().checkSession());

installSaveActionImpl(() => {
  const cloud = useCloudStore.getState();
  if (cloud.user) cloud.setProjectsModalOpen(true);
  else cloud.setAuthModalOpen(true);
});
