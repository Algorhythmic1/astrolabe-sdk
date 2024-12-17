use std::cmp::max;

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::*;
use crate::id;

pub const MAX_TIME_LOCK: u32 = 3 * 30 * 24 * 60 * 60; // 3 months

#[account]
pub struct Settings {
    /// Key that is used to seed the settings PDA.
    pub seed: Pubkey,
    /// The authority that can change the smart account settings.
    /// This is a very important parameter as this authority can change the signers and threshold.
    ///
    /// The convention is to set this to `Pubkey::default()`.
    /// In this case, the smart account becomes autonomous, so every settings change goes through
    /// the normal process of voting by the signers.
    ///
    /// However, if this parameter is set to any other key, all the setting changes for this smart account settings
    /// will need to be signed by the `settings_authority`. We call such a smart account a "controlled smart account".
    pub settings_authority: Pubkey,
    /// Threshold for signatures.
    pub threshold: u16,
    /// How many seconds must pass between transaction voting settlement and execution.
    pub time_lock: u32,
    /// Last transaction index. 0 means no transactions have been created.
    pub transaction_index: u64,
    /// Last stale transaction index. All transactions up until this index are stale.
    /// This index is updated when smart account settings (members/threshold/time_lock) change.
    pub stale_transaction_index: u64,
    /// The address where the rent for the accounts related to executed, rejected, or cancelled
    /// transactions can be reclaimed. If set to `None`, the rent reclamation feature is turned off.
    pub rent_collector: Option<Pubkey>,
    /// Bump for the smart account PDA seed.
    pub bump: u8,
    /// Signers attached to the smart account
    pub signers: Vec<SmartAccountSigner>,
}

impl Settings {
    pub fn size(signers_length: usize) -> usize {
        8  + // anchor account discriminator
        32 + // seed
        32 + // settings_authority
        2  + // threshold
        4  + // time_lock
        8  + // transaction_index
        8  + // stale_transaction_index
        1  + // rent_collector Option discriminator
        32 + // rent_collector (always 32 bytes, even if None, just to keep the realloc logic simpler)
        1  + // bump
        4  + // signers vector length
        signers_length * SmartAccountSigner::INIT_SPACE // signers
    }

    pub fn num_voters(signers: &[SmartAccountSigner]) -> usize {
        signers
            .iter()
            .filter(|m| m.permissions.has(Permission::Vote))
            .count()
    }

    pub fn num_proposers(signers: &[SmartAccountSigner]) -> usize {
        signers
            .iter()
            .filter(|m| m.permissions.has(Permission::Initiate))
            .count()
    }

    pub fn num_executors(signers: &[SmartAccountSigner]) -> usize {
        signers
            .iter()
            .filter(|m| m.permissions.has(Permission::Execute))
            .count()
    }

    /// Check if the multisig account space needs to be reallocated to accommodate `members_length`.
    /// Returns `true` if the account was reallocated.
    pub fn realloc_if_needed<'a>(
        multisig: AccountInfo<'a>,
        members_length: usize,
        rent_payer: Option<AccountInfo<'a>>,
        system_program: Option<AccountInfo<'a>>,
    ) -> Result<bool> {
        // Sanity checks
        require_keys_eq!(
            *multisig.owner,
            id(),
            SmartAccountError::IllegalAccountOwner
        );

        let current_account_size = multisig.data.borrow().len();
        let account_size_to_fit_members = Settings::size(members_length);

        // Check if we need to reallocate space.
        if current_account_size >= account_size_to_fit_members {
            return Ok(false);
        }

        let new_size = account_size_to_fit_members;

        // Reallocate more space.
        AccountInfo::realloc(&multisig, new_size, false)?;

        // If more lamports are needed, transfer them to the account.
        let rent_exempt_lamports = Rent::get().unwrap().minimum_balance(new_size).max(1);
        let top_up_lamports =
            rent_exempt_lamports.saturating_sub(multisig.to_account_info().lamports());

        if top_up_lamports > 0 {
            let system_program = system_program.ok_or(SmartAccountError::MissingAccount)?;
            require_keys_eq!(
                *system_program.key,
                system_program::ID,
                SmartAccountError::InvalidAccount
            );

            let rent_payer = rent_payer.ok_or(SmartAccountError::MissingAccount)?;

            system_program::transfer(
                CpiContext::new(
                    system_program,
                    system_program::Transfer {
                        from: rent_payer,
                        to: multisig,
                    },
                ),
                top_up_lamports,
            )?;
        }

        Ok(true)
    }

    // Makes sure the multisig state is valid.
    // This must be called at the end of every instruction that modifies a Multisig account.
    pub fn invariant(&self) -> Result<()> {
        let Self {
            threshold,
            signers,
            transaction_index,
            stale_transaction_index,
            ..
        } = self;
        // Max number of members is u16::MAX.
        require!(
            signers.len() <= usize::from(u16::MAX),
            SmartAccountError::TooManySigners
        );

        // There must be no duplicate members.
        let has_duplicates = signers.windows(2).any(|win| win[0].key == win[1].key);
        require!(!has_duplicates, SmartAccountError::DuplicateSigner);

        // Members must not have unknown permissions.
        require!(
            signers.iter().all(|m| m.permissions.mask < 8), // 8 = Initiate | Vote | Execute
            SmartAccountError::UnknownPermission
        );

        // There must be at least one member with Initiate permission.
        let num_proposers = Self::num_proposers(signers);
        require!(num_proposers > 0, SmartAccountError::NoProposers);

        // There must be at least one member with Execute permission.
        let num_executors = Self::num_executors(signers);
        require!(num_executors > 0, SmartAccountError::NoExecutors);

        // There must be at least one member with Vote permission.
        let num_voters = Self::num_voters(signers);
        require!(num_voters > 0, SmartAccountError::NoVoters);

        // Threshold must be greater than 0.
        require!(*threshold > 0, SmartAccountError::InvalidThreshold);

        // Threshold must not exceed the number of voters.
        require!(
            usize::from(*threshold) <= num_voters,
            SmartAccountError::InvalidThreshold
        );

        // `state.stale_transaction_index` must be less than or equal to `state.transaction_index`.
        require!(
            stale_transaction_index <= transaction_index,
            SmartAccountError::InvalidStaleTransactionIndex
        );

        // Time Lock must not exceed the maximum allowed to prevent bricking the multisig.
        require!(
            self.time_lock <= MAX_TIME_LOCK,
            SmartAccountError::TimeLockExceedsMaxAllowed
        );

        Ok(())
    }

    /// Makes the transactions created up until this moment stale.
    /// Should be called whenever any multisig parameter related to the voting consensus is changed.
    pub fn invalidate_prior_transactions(&mut self) {
        self.stale_transaction_index = self.transaction_index;
    }

    /// Returns `Some(index)` if `member_pubkey` is a member, with `index` into the `members` vec.
    /// `None` otherwise.
    pub fn is_signer(&self, signer_pubkey: Pubkey) -> Option<usize> {
        self.signers
            .binary_search_by_key(&signer_pubkey, |m| m.key)
            .ok()
    }

    pub fn signer_has_permission(&self, signer_pubkey: Pubkey, permission: Permission) -> bool {
        match self.is_signer(signer_pubkey) {
            Some(index) => self.signers[index].permissions.has(permission),
            _ => false,
        }
    }

    /// How many "reject" votes are enough to make the transaction "Rejected".
    /// The cutoff must be such that it is impossible for the remaining voters to reach the approval threshold.
    /// For example: total voters = 7, threshold = 3, cutoff = 5.
    pub fn cutoff(&self) -> usize {
        Self::num_voters(&self.signers)
            .checked_sub(usize::from(self.threshold))
            .unwrap()
            .checked_add(1)
            .unwrap()
    }

    /// Add `new_member` to the multisig `members` vec and sort the vec.
    pub fn add_signer(&mut self, new_signer: SmartAccountSigner) {
        self.signers.push(new_signer);
        self.signers.sort_by_key(|m| m.key);
    }

    /// Remove `member_pubkey` from the multisig `members` vec.
    ///
    /// # Errors
    /// - `SmartAccountError::NotASigner` if `member_pubkey` is not a member.
    pub fn remove_signer(&mut self, signer_pubkey: Pubkey) -> Result<()> {
        let old_signer_index = match self.is_signer(signer_pubkey) {
            Some(old_signer_index) => old_signer_index,
            None => return err!(SmartAccountError::NotASigner),
        };

        self.signers.remove(old_signer_index);

        Ok(())
    }
}

#[derive(AnchorDeserialize, AnchorSerialize, InitSpace, Eq, PartialEq, Clone)]
pub struct SmartAccountSigner {
    pub key: Pubkey,
    pub permissions: Permissions,
}

#[derive(Clone, Copy)]
pub enum Permission {
    Initiate = 1 << 0,
    Vote = 1 << 1,
    Execute = 1 << 2,
}

/// Bitmask for permissions.
#[derive(
    AnchorSerialize, AnchorDeserialize, InitSpace, Eq, PartialEq, Clone, Copy, Default, Debug,
)]
pub struct Permissions {
    pub mask: u8,
}

impl Permissions {
    /// Currently unused.
    pub fn from_vec(permissions: &[Permission]) -> Self {
        let mut mask = 0;
        for permission in permissions {
            mask |= *permission as u8;
        }
        Self { mask }
    }

    pub fn has(&self, permission: Permission) -> bool {
        self.mask & (permission as u8) != 0
    }
}
