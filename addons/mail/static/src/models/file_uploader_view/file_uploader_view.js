/** @odoo-module **/

import { registerModel } from '@mail/model/model_core';
import { attr, many2one, one2one } from '@mail/model/model_field';
import { clear, replace } from '@mail/model/model_field_command';

import core from 'web.core';

const getAttachmentNextTemporaryId = (function () {
    let tmpId = 0;
    return () => {
        tmpId -= 1;
        return tmpId;
    };
})();

registerModel({
    name: 'FileUploaderView',
    identifyingFields: [['activityView', 'attachmentBoxView', 'composerView']],
    lifecycleHooks: {
        _created() {
            this.onChangeAttachment = this.onChangeAttachment.bind(this);
        }
    },
    recordMethods: {
        openBrowserFileUploader() {
            this.fileInputRef.el.click();
        },
        /**
         * Called when there are changes in the file input.
         *
         * @param {Event} ev
         * @param {EventTarget} ev.target
         * @param {FileList|Array} ev.target.files
         */
        onChangeAttachment(ev) {
            this.uploadFiles(ev.target.files);
        },
        /**
         * @param {FileList|Array} files
         * @returns {Promise}
         */
        async uploadFiles(files) {
            await this._performUpload({ files });
            if (this.fileInputRef && this.fileInputRef.el) {
                this.fileInputRef.el.value = '';
            }
        },
        /**
         * @private
         * @returns {FieldCommand}
         */
        _computeThread() {
            if (this.activityView) {
                return replace(this.activityView.activity.thread);
            }
            if (this.attachmentBoxView) {
                return replace(this.attachmentBoxView.chatter.thread);
            }
            if (this.composerView) {
                return replace(this.composerView.composer.activeThread);
            }
            return clear();
        },
        /**
         * @private
         * @param {Object} param0
         * @param {Composer} param0.composer
         * @param {File} param0.file
         * @param {Thread} param0.thread
         * @returns {FormData}
         */
        _createFormData({ composer, file, thread }) {
            const formData = new window.FormData();
            formData.append('csrf_token', core.csrf_token);
            formData.append('is_pending', Boolean(composer));
            formData.append('thread_id', thread && thread.id);
            formData.append('thread_model', thread && thread.model);
            formData.append('ufile', file, file.name);
            return formData;
        },
        /**
         * @private
         * @param {Object} param0
         * @param {Object} param0.attachmentData
         * @param {Composer} param0.composer
         * @param {Thread} param0.thread
         * @returns {Attachment}
         */
        _onAttachmentUploaded({ attachmentData, composer, thread }) {
            if (attachmentData.error || !attachmentData.id) {
                this.env.services['notification'].notify({
                    type: 'danger',
                    message: attachmentData.error,
                });
                return;
            }
            return this.messaging.models['Attachment'].insert({
                composer: composer && replace(composer),
                originThread: (!composer && thread) ? replace(thread) : undefined,
                ...attachmentData,
            });
        },
        /**
         * @private
         * @param {Object} param0
         * @param {FileList|Array} param0.files
         * @returns {Promise}
         */
        async _performUpload({ files }) {
            const composer = this.composerView && this.composerView.composer; // save before async
            const thread = this.thread; // save before async
            const chatter = this.attachmentBoxView && this.attachmentBoxView.chatter; // save before async
            const activity = this.activityView && this.activityView.activity; // save before async
            const uploadingAttachments = new Map();
            for (const file of files) {
                uploadingAttachments.set(file, this.messaging.models['Attachment'].insert({
                    composer: composer && replace(composer),
                    filename: file.name,
                    id: getAttachmentNextTemporaryId(),
                    isUploading: true,
                    mimetype: file.type,
                    name: file.name,
                    originThread: (!composer && thread) ? replace(thread) : undefined,
                }));
            }
            const attachments = [];
            for (const file of files) {
                const uploadingAttachment = uploadingAttachments.get(file);
                if (!uploadingAttachment.exists()) {
                    // This happens when a pending attachment is being deleted by user before upload.
                    continue;
                }
                if ((composer && !composer.exists()) || (thread && !thread.exists())) {
                    return;
                }
                try {
                    const response = await this.env.browser.fetch('/mail/attachment/upload', {
                        method: 'POST',
                        body: this._createFormData({ composer, file, thread }),
                        signal: uploadingAttachment.uploadingAbortController.signal,
                    });
                    const attachmentData = await response.json();
                    if (uploadingAttachment.exists()) {
                        uploadingAttachment.delete();
                    }
                    if ((composer && !composer.exists()) || (thread && !thread.exists())) {
                        return;
                    }
                    const attachment = this._onAttachmentUploaded({ attachmentData, composer, thread });
                    attachments.push(attachment);
                } catch (e) {
                    if (e.name !== 'AbortError') {
                        throw e;
                    }
                }
            }
            if (chatter && chatter.exists() && chatter.hasParentReloadOnAttachmentsChanged) {
                chatter.reloadParentView();
            }
            if (activity && activity.exists()) {
                activity.markAsDone({ attachments });
            }
        },
    },
    fields: {
        activityView: one2one('ActivityView', {
            inverse: 'fileUploaderView',
            readonly: true,
        }),
        attachmentBoxView: one2one('AttachmentBoxView', {
            inverse: 'fileUploaderView',
            readonly: true,
        }),
        composerView: one2one('ComposerView', {
            inverse: 'fileUploaderView',
            readonly: true,
        }),
        fileInputRef: attr(),
        thread: many2one('Thread', {
            compute: '_computeThread',
            readonly: true,
            required: true,
        })
    },
});
